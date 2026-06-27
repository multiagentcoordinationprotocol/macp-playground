import { Injectable, Logger, OnModuleInit, HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

function configError(message: string): AppException {
  return new AppException(ErrorCode.INVALID_CONFIG, message, HttpStatus.INTERNAL_SERVER_ERROR);
}

function readBoolean(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readStringList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Partial MACP scopes map. Matches the fields accepted by the auth-service
 * `/tokens` body (`scopes`) and emitted as the JWT `macp_scopes` claim. See
 * `runtime/src/auth/resolvers/jwt_bearer.rs:15-27`.
 */
export interface MacpScopes {
  can_start_sessions?: boolean;
  can_manage_mode_registry?: boolean;
  is_observer?: boolean;
  allowed_modes?: string[];
  max_open_sessions?: number;
}

function readScopesMap(name: string): Record<string, MacpScopes> {
  const raw = process.env[name];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError(`${name} must be valid JSON (object of sender→scopes)`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError(`${name} must be a JSON object keyed by sender`);
  }
  const result: Record<string, MacpScopes> = {};
  for (const [sender, scopes] of Object.entries(parsed as Record<string, unknown>)) {
    if (!sender.trim()) continue;
    if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) {
      throw configError(`${name}[${sender}] must be a JSON object of scope fields`);
    }
    result[sender] = scopes as MacpScopes;
  }
  return result;
}

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);

  readonly nodeEnv = process.env.NODE_ENV ?? 'development';
  readonly isDevelopment = this.nodeEnv === 'development';

  readonly port = readNumber('PORT', 3000);
  readonly host = process.env.HOST ?? '0.0.0.0';
  readonly corsOrigins = readStringList('CORS_ORIGIN');
  readonly corsOrigin: string | string[] = this.corsOrigins.length > 0 ? this.corsOrigins : 'http://localhost:3000';

  readonly packsDir = process.env.PACKS_DIR ?? './packs';
  readonly registryCacheTtlMs = readNumber('REGISTRY_CACHE_TTL_MS', 0);

  readonly authApiKeys = readStringList('AUTH_API_KEYS');
  readonly logLevel = process.env.LOG_LEVEL ?? 'info';

  readonly autoBootstrapExampleAgents = readBoolean('AUTO_BOOTSTRAP_EXAMPLE_AGENTS', true);
  readonly registerPoliciesOnLaunch = readBoolean('REGISTER_POLICIES_ON_LAUNCH', true);
  readonly exampleAgentPythonPath = process.env.EXAMPLE_AGENT_PYTHON_PATH ?? 'python3';
  readonly exampleAgentNodePath = process.env.EXAMPLE_AGENT_NODE_PATH ?? process.execPath;

  /**
   * gRPC endpoint that spawned agents connect to directly. Required —
   * bootstrap writes this into `runtime.address` so agents open their own
   * gRPC channel to the runtime (RFC-MACP-0004 §4).
   */
  readonly runtimeAddress = process.env.MACP_RUNTIME_ADDRESS ?? '';
  readonly runtimeTls = readBoolean('MACP_RUNTIME_TLS', true);
  /**
   * Escape hatch for local dev only. When `MACP_RUNTIME_TLS=false`, this must
   * also be set to acknowledge the RFC-MACP-0006 §3 violation explicitly. The
   * SDKs enforce the same rule client-side.
   */
  readonly runtimeAllowInsecure = readBoolean('MACP_RUNTIME_ALLOW_INSECURE', false);

  /**
   * Optional host/port that spawned agents bind for the cancel callback HTTP
   * server (RFC-0001 §7.2 / Option A). If `host` is set, each agent binds a
   * per-process port starting from `portBase` (next free port used). Empty
   * host disables the callback server entirely.
   */
  readonly cancelCallbackHost = process.env.MACP_CANCEL_CALLBACK_HOST ?? '127.0.0.1';
  readonly cancelCallbackPortBase = readNumber('MACP_CANCEL_CALLBACK_PORT_BASE', 0);
  readonly cancelCallbackPath = process.env.MACP_CANCEL_CALLBACK_PATH ?? '/agent/cancel';

  /**
   * Auth-service base URL. Required — every agent spawn mints a JWT via
   * `POST /tokens` (RFC-MACP-0004 §5). See plans/auth-2-jwt-integration.md.
   */
  readonly authServiceUrl: string = process.env.MACP_AUTH_SERVICE_URL ?? '';
  readonly authServiceTimeoutMs: number = readNumber('MACP_AUTH_SERVICE_TIMEOUT_MS', 5000);
  /**
   * TTL in seconds requested from the auth-service for every mint. Must exceed
   * the agent process's gRPC stream lifetime — the SDKs bind auth once at
   * stream open and cannot refresh. auth-service caps at `MACP_AUTH_MAX_TTL_SECONDS`
   * (default 3600s), so to go longer operators must also raise that cap.
   */
  readonly authTokenTtlSeconds: number = readNumber('MACP_AUTH_TOKEN_TTL_SECONDS', 3600);
  /**
   * Optional per-sender scope overrides; deep-merged onto the role defaults
   * computed by the provider. Explicit keys in the override replace the
   * computed defaults (see `AuthTokenMinterService.mergeScopes`).
   */
  readonly authScopeOverrides: Record<string, MacpScopes> = readScopesMap('MACP_AUTH_SCOPES_JSON');

  onModuleInit(): void {
    this.logger.log(`packs directory: ${this.packsDir}`);
    this.logger.log(`cache TTL: ${this.registryCacheTtlMs}ms`);
    this.logger.log(`runtime: ${this.runtimeAddress || '(unset)'}`);
    if (!this.runtimeTls && !this.runtimeAllowInsecure) {
      this.logger.warn(
        'MACP_RUNTIME_TLS=false without MACP_RUNTIME_ALLOW_INSECURE=true: agents will refuse to open the channel (RFC-MACP-0006 §3).'
      );
    }
    this.validateAuthConfig();
    this.logger.log(`auth: jwt (auth-service=${this.authServiceUrl})`);
  }

  private validateAuthConfig(): void {
    if (!this.authServiceUrl) {
      throw configError('MACP_AUTH_SERVICE_URL is required (points at the auth-service base URL)');
    }
    if (this.authTokenTtlSeconds <= 0) {
      throw configError('MACP_AUTH_TOKEN_TTL_SECONDS must be a positive integer');
    }
  }
}

export { readBoolean, readNumber, readStringList, readScopesMap };
