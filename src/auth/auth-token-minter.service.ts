import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfigService, MacpScopes } from '../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import type { MintedToken, MintRequest, MintResponse } from './auth.types';

interface CacheEntry {
  token: string;
  expiresAt: number;
  expiresInSeconds: number;
}

/**
 * Mints short-lived JWTs for spawned agents against the standalone
 * `auth-service` (`POST /tokens`). See plans/auth-2-jwt-integration.md for
 * the full rationale and invariants.
 *
 * Each agent process receives a single token for its entire gRPC stream
 * lifetime — the SDKs bind auth once at stream open and cannot refresh
 * (TS `client.ts:420`, Python `client.py:84-97`). The in-memory cache
 * exists only to coalesce concurrent spawns in one launch burst and to
 * avoid re-minting for the same sender within the TTL window.
 */
@Injectable()
export class AuthTokenMinterService {
  private readonly logger = new Logger(AuthTokenMinterService.name);

  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<MintedToken>>();

  // 10s buffer for clock drift between macp-playground and auth-service.
  private static readonly CLOCK_SKEW_MS = 10_000;

  constructor(private readonly config: AppConfigService) {}

  /**
   * Return a Bearer JWT for `sender`. Cached while within TTL (minus a small
   * skew window). Throws `AppException(AUTH_MINT_FAILED, 502)` on auth-service
   * failure.
   */
  async mintToken(sender: string, scopes?: MacpScopes): Promise<MintedToken> {
    if (!sender) {
      throw new AppException(
        ErrorCode.AUTH_MINT_FAILED,
        'mintToken requires a non-empty sender',
        HttpStatus.BAD_GATEWAY
      );
    }

    const key = this.cacheKey(sender, scopes);
    const cached = this.readCache(key);
    if (cached) {
      return { ...cached, sender, cacheOutcome: 'hit' };
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.requestToken(sender, scopes).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Merge a per-sender scope override (from `MACP_AUTH_SCOPES_JSON`) onto
   * the role-derived defaults computed by the caller. Override keys replace
   * defaults verbatim; explicit `null` clears a field.
   */
  mergeScopes(base: MacpScopes, override?: MacpScopes): MacpScopes {
    if (!override) return base;
    const merged: MacpScopes = { ...base };
    for (const [key, value] of Object.entries(override) as Array<[keyof MacpScopes, unknown]>) {
      if (value === null) {
        delete merged[key];
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous scope shape
        (merged as any)[key] = value;
      }
    }
    return merged;
  }

  private readCache(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt - AuthTokenMinterService.CLOCK_SKEW_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  private async requestToken(sender: string, scopes?: MacpScopes): Promise<MintedToken> {
    const base = this.config.authServiceUrl;
    if (!base) {
      throw new AppException(
        ErrorCode.AUTH_MINT_FAILED,
        'MACP_AUTH_SERVICE_URL is not configured; cannot mint tokens',
        HttpStatus.BAD_GATEWAY
      );
    }

    const url = `${base.replace(/\/+$/, '')}/tokens`;
    const body: MintRequest = {
      sender,
      ttl_seconds: this.config.authTokenTtlSeconds
    };
    if (scopes) body.scopes = scopes;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.authServiceTimeoutMs)
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown network error';
      this.logger.warn(`auth_mint_failure sender=${sender} reason=network:${reason}`);
      throw new AppException(
        ErrorCode.AUTH_MINT_FAILED,
        `auth-service request failed: ${reason}`,
        HttpStatus.BAD_GATEWAY
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      this.logger.warn(
        `auth_mint_failure sender=${sender} reason=http_${response.status} body=${bodyText.slice(0, 200)}`
      );
      throw new AppException(
        ErrorCode.AUTH_MINT_FAILED,
        `auth-service returned ${response.status}`,
        HttpStatus.BAD_GATEWAY,
        { status: response.status }
      );
    }

    let parsed: MintResponse;
    try {
      parsed = (await response.json()) as MintResponse;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid JSON';
      throw new AppException(
        ErrorCode.AUTH_MINT_FAILED,
        `auth-service response parse failed: ${reason}`,
        HttpStatus.BAD_GATEWAY
      );
    }

    if (!parsed || typeof parsed.token !== 'string' || !parsed.token) {
      throw new AppException(
        ErrorCode.AUTH_MINT_FAILED,
        'auth-service response missing token',
        HttpStatus.BAD_GATEWAY
      );
    }

    const ttlSeconds = Number.isFinite(parsed.expires_in_seconds)
      ? Math.max(1, Math.floor(parsed.expires_in_seconds))
      : this.config.authTokenTtlSeconds;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    const key = this.cacheKey(sender, scopes);
    this.cache.set(key, { token: parsed.token, expiresAt, expiresInSeconds: ttlSeconds });

    this.logger.log(`auth_mint_success sender=${sender} expires_in=${ttlSeconds}s`);

    return {
      token: parsed.token,
      sender,
      expiresAt,
      expiresInSeconds: ttlSeconds,
      cacheOutcome: 'miss'
    };
  }

  private cacheKey(sender: string, scopes?: MacpScopes): string {
    return `${sender}::${this.stableScopeHash(scopes)}`;
  }

  private stableScopeHash(scopes?: MacpScopes): string {
    if (!scopes) return '';
    const keys = Object.keys(scopes).sort();
    const ordered: Record<string, unknown> = {};
    for (const k of keys) {
      const value = (scopes as Record<string, unknown>)[k];
      if (Array.isArray(value)) {
        ordered[k] = [...value].sort();
      } else {
        ordered[k] = value;
      }
    }
    return JSON.stringify(ordered);
  }
}
