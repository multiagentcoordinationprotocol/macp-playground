import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as path from 'node:path';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { AuthTokenMinterService } from '../../src/auth/auth-token-minter.service';
import { ExampleAgentCatalogService } from '../../src/example-agents/example-agent-catalog.service';
import { GlobalExceptionFilter } from '../../src/errors/exception.filter';
import { MockControlPlane } from './mock-control-plane';
import { IntegrationTestClient } from './integration-test-client';
import { buildStubExampleAgentCatalog } from '../fixtures/stub-example-agent-catalog';

export type ControlPlaneMode = 'mock' | 'docker' | 'remote';

export interface IntegrationTestContext {
  app: INestApplication;
  url: string;
  client: IntegrationTestClient;
  mockControlPlane: MockControlPlane | null;
  module: TestingModule;
  controlPlaneMode: ControlPlaneMode;
  cleanup: () => Promise<void>;
}

export async function createIntegrationTestApp(
  overrides?: Partial<{
    autoBootstrapExampleAgents: boolean;
    authApiKeys: string[];
    mockControlPlaneOptions: { requiredBearerToken?: string };
    runtimeAddress: string;
    runtimeTls: boolean;
    runtimeAllowInsecure: boolean;
    authServiceUrl: string;
    authServiceTimeoutMs: number;
    authTokenTtlSeconds: number;
    authScopeOverrides: Record<string, Record<string, unknown>>;
    /** Set to false to use the real AuthTokenMinterService (and hit authServiceUrl over HTTP). */
    stubAuthMinter: boolean;
    /**
     * Set to false to spawn the real production agent workers instead of the
     * dependency-free stub. Only meaningful in `mock` mode — `docker`/`remote`
     * mode always uses the real catalog (that's the point of those modes).
     */
    stubExampleAgentCatalog: boolean;
    controlPlaneUrl: string;
    controlPlaneTimeoutMs: number;
    controlPlaneApiKey: string;
  }>
): Promise<IntegrationTestContext> {
  const controlPlaneMode = (process.env.INTEGRATION_CONTROL_PLANE ?? 'mock') as ControlPlaneMode;
  const fixturesPacksDir = path.resolve(__dirname, '../fixtures/packs');

  // `docker`/`remote` mode targets the real stack brought up by
  // `docker-compose.fullstack.yml` (see CLAUDE.md's Docker section) — same
  // ports/credentials that compose file wires between its services. These are
  // only the *defaults*; an explicit override always wins, so specs that need
  // a scoped mock (e.g. auth-minting.integration.spec.ts's in-process
  // MockAuthService) are unaffected.
  const isRealStack = controlPlaneMode !== 'mock';

  // The MockControlPlane is retained for observer-style assertions only; the
  // playground no longer issues any control-plane HTTP calls (RFC-MACP-0004 §4).
  let mockControlPlane: MockControlPlane | null = null;
  if (controlPlaneMode === 'mock') {
    mockControlPlane = new MockControlPlane(overrides?.mockControlPlaneOptions);
    await mockControlPlane.start();
  }

  let builder = Test.createTestingModule({ imports: [AppModule] });

  // Default to stubbing the minter only in `mock` mode; `docker`/`remote`
  // mode defaults to the real AuthTokenMinterService hitting a live
  // auth-service, which is the whole point of those modes. An explicit
  // `stubAuthMinter` override always takes precedence either way.
  const shouldStubAuthMinter = overrides?.stubAuthMinter ?? controlPlaneMode === 'mock';
  if (shouldStubAuthMinter) {
    builder = builder.overrideProvider(AuthTokenMinterService).useValue({
      mintToken: async (sender: string) => ({
        token: `jwt-${sender}-integration`,
        sender,
        expiresAt: Date.now() + 3600_000,
        expiresInSeconds: 3600,
        cacheOutcome: 'miss' as const
      }),
      mergeScopes: (base: Record<string, unknown>, override?: Record<string, unknown>) => ({
        ...base,
        ...(override ?? {})
      })
    });
  }

  // `mock` mode never installs the production Python workers' dependencies
  // (macp_sdk + langgraph/langchain/crewai) — only the docker-built image
  // does (see the repo Dockerfile). Spawning the real entrypoints there would
  // make every /examples/run attach fail under PG-1's spawn-confirmation gate
  // for reasons that have nothing to do with the behavior under test. Default
  // to the dependency-free stub catalog in `mock` mode; `docker`/`remote`
  // mode always uses the real one — that's the whole point of those modes.
  const shouldStubAgentCatalog = overrides?.stubExampleAgentCatalog ?? controlPlaneMode === 'mock';
  if (shouldStubAgentCatalog) {
    builder = builder.overrideProvider(ExampleAgentCatalogService).useValue(buildStubExampleAgentCatalog());
  }

  const moduleRef = await builder
    .overrideProvider(AppConfigService)
    .useValue({
      packsDir: fixturesPacksDir,
      registryCacheTtlMs: 0,
      corsOrigin: '*',
      isDevelopment: true,
      port: 0,
      host: '0.0.0.0',
      logLevel: 'warn',
      autoBootstrapExampleAgents: overrides?.autoBootstrapExampleAgents ?? true,
      registerPoliciesOnLaunch: true,
      exampleAgentPythonPath: 'python3',
      exampleAgentNodePath: process.execPath,
      authApiKeys: overrides?.authApiKeys ?? [],
      runtimeAddress:
        overrides?.runtimeAddress ?? (isRealStack ? (process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051') : ''),
      runtimeTls: overrides?.runtimeTls ?? (isRealStack ? false : true),
      runtimeAllowInsecure: overrides?.runtimeAllowInsecure ?? (isRealStack ? true : false),
      cancelCallbackHost: '127.0.0.1',
      cancelCallbackPortBase: 0,
      cancelCallbackPath: '/agent/cancel',
      authServiceUrl:
        overrides?.authServiceUrl ??
        (isRealStack ? (process.env.MACP_AUTH_SERVICE_URL ?? 'http://localhost:3200') : 'http://auth-stub:3200'),
      authServiceTimeoutMs: overrides?.authServiceTimeoutMs ?? 5000,
      authTokenTtlSeconds: overrides?.authTokenTtlSeconds ?? 3600,
      authScopeOverrides: overrides?.authScopeOverrides ?? {},
      controlPlaneUrl:
        overrides?.controlPlaneUrl ??
        mockControlPlane?.baseUrl ??
        (isRealStack ? (process.env.MACP_CONTROL_PLANE_URL ?? 'http://localhost:3001') : ''),
      controlPlaneTimeoutMs: overrides?.controlPlaneTimeoutMs ?? 5000,
      controlPlaneApiKey:
        overrides?.controlPlaneApiKey ?? (isRealStack ? (process.env.MACP_CONTROL_PLANE_API_KEY ?? 'demo-key') : '')
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false
    })
  );

  await app.listen(0);
  const url = await app.getUrl();
  const client = new IntegrationTestClient(url);

  const cleanup = async () => {
    await app.close();
    if (mockControlPlane) {
      await mockControlPlane.stop();
    }
  };

  return {
    app,
    url,
    client,
    mockControlPlane,
    module: moduleRef,
    controlPlaneMode,
    cleanup
  };
}
