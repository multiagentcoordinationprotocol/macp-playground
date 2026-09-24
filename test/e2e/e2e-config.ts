import * as path from 'node:path';
import { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { AuthTokenMinterService } from '../../src/auth/auth-token-minter.service';
import { ExampleAgentCatalogService } from '../../src/example-agents/example-agent-catalog.service';
import { buildStubExampleAgentCatalog } from '../fixtures/stub-example-agent-catalog';

const fixturesPacksDir = path.resolve(__dirname, '../fixtures/packs');

/**
 * Override `AuthTokenMinterService.mintToken` with a deterministic stub so
 * e2e tests don't require a real auth-service sidecar. Returns the builder for
 * chaining.
 */
export function stubAuthMinter(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder.overrideProvider(AuthTokenMinterService).useValue({
    mintToken: async (sender: string) => ({
      token: `jwt-${sender}-e2e`,
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

export function installAuthMinterStub(module: TestingModule): void {
  // no-op placeholder — reserved for future interceptor setup if needed
  void module;
}

/**
 * Override `ExampleAgentCatalogService` with a dependency-free stub catalog
 * for e2e specs that call `/examples/run` and actually bootstrap agents.
 * Spawning the real production Python workers here would require
 * macp_sdk + langgraph/langchain/crewai to be installed, which this fast e2e
 * tier never does (only the docker-built image installs
 * agents/requirements.txt — see the repo Dockerfile) — every attach would
 * fail under PG-1's spawn-confirmation gate for reasons unrelated to what
 * these specs are testing.
 */
export function stubExampleAgentCatalog(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder.overrideProvider(ExampleAgentCatalogService).useValue(buildStubExampleAgentCatalog());
}

/**
 * Shared AppConfigService stub for e2e tests. Agents always mint a JWT via the
 * auth-service; the e2e tier points at a stub URL that the auth minter spy
 * overrides.
 */
export function buildE2eConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packsDir: fixturesPacksDir,
    registryCacheTtlMs: 0,
    corsOrigin: '*',
    isDevelopment: true,
    port: 0,
    host: '0.0.0.0',
    logLevel: 'error',
    autoBootstrapExampleAgents: true,
    registerPoliciesOnLaunch: false,
    exampleAgentPythonPath: 'python3',
    exampleAgentNodePath: process.execPath,
    authApiKeys: [],
    runtimeAddress: '',
    runtimeTls: true,
    runtimeAllowInsecure: false,
    cancelCallbackHost: '127.0.0.1',
    cancelCallbackPortBase: 0,
    cancelCallbackPath: '/agent/cancel',
    authServiceUrl: 'http://auth-stub:3200',
    authServiceTimeoutMs: 5000,
    authTokenTtlSeconds: 3600,
    authScopeOverrides: {},
    ...overrides
  };
}
