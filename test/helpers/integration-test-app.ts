import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as path from 'node:path';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { AuthTokenMinterService } from '../../src/auth/auth-token-minter.service';
import { GlobalExceptionFilter } from '../../src/errors/exception.filter';
import { MockControlPlane } from './mock-control-plane';
import { IntegrationTestClient } from './integration-test-client';

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
  }>
): Promise<IntegrationTestContext> {
  const controlPlaneMode = (process.env.INTEGRATION_CONTROL_PLANE ?? 'mock') as ControlPlaneMode;
  const fixturesPacksDir = path.resolve(__dirname, '../fixtures/packs');

  // The MockControlPlane is retained for observer-style assertions only; the
  // playground no longer issues any control-plane HTTP calls (RFC-MACP-0004 §4).
  let mockControlPlane: MockControlPlane | null = null;
  if (controlPlaneMode === 'mock') {
    mockControlPlane = new MockControlPlane(overrides?.mockControlPlaneOptions);
    await mockControlPlane.start();
  }

  let builder = Test.createTestingModule({ imports: [AppModule] });

  if (overrides?.stubAuthMinter !== false) {
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
      runtimeAddress: overrides?.runtimeAddress ?? '',
      runtimeTls: overrides?.runtimeTls ?? true,
      runtimeAllowInsecure: overrides?.runtimeAllowInsecure ?? false,
      cancelCallbackHost: '127.0.0.1',
      cancelCallbackPortBase: 0,
      cancelCallbackPath: '/agent/cancel',
      authServiceUrl: overrides?.authServiceUrl ?? 'http://auth-stub:3200',
      authServiceTimeoutMs: overrides?.authServiceTimeoutMs ?? 5000,
      authTokenTtlSeconds: overrides?.authTokenTtlSeconds ?? 3600,
      authScopeOverrides: overrides?.authScopeOverrides ?? {}
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
