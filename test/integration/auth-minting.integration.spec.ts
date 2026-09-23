import { AuthTokenMinterService } from '../../src/auth/auth-token-minter.service';
import { LaunchSupervisor } from '../../src/hosting/launch-supervisor';
import { BootstrapPayload } from '../../src/hosting/contracts/bootstrap.types';
import { createIntegrationTestApp, IntegrationTestContext } from '../helpers/integration-test-app';
import { MockAuthService } from '../helpers/mock-auth-service';
import { fraudScenarioRunRequest } from '../fixtures/integration-requests';

describe('AUTH-2 JWT minting (integration)', () => {
  let authMock: MockAuthService;

  beforeEach(async () => {
    authMock = new MockAuthService();
    await authMock.start();
  });

  afterEach(async () => {
    await authMock.stop();
  });

  describe('AuthTokenMinterService against live mock', () => {
    let ctx: IntegrationTestContext;

    beforeEach(async () => {
      ctx = await createIntegrationTestApp({
        stubAuthMinter: false,
        authServiceUrl: authMock.baseUrl,
        authServiceTimeoutMs: 3000,
        authTokenTtlSeconds: 900,
        autoBootstrapExampleAgents: false,
        // Isolated minter test: keep PolicyRegistrarService's own bootstrap-time
        // admin mint out of this scoped mock's request count (it registers
        // policies whenever runtimeAddress is set — see policy-registrar.service.ts).
        // In `docker`/`remote` mode runtimeAddress otherwise defaults to a real
        // address (see integration-test-app.ts), which would add an extra
        // "macp-playground" record before the assertions below run.
        runtimeAddress: ''
      });
    });

    afterEach(async () => {
      if (ctx) await ctx.cleanup();
    });

    it('mints a JWT with correct request body and caches within TTL', async () => {
      const minter = ctx.app.get(AuthTokenMinterService);
      const first = await minter.mintToken('risk-agent', {
        can_start_sessions: true,
        is_observer: false,
        allowed_modes: ['macp.mode.decision.v1']
      });
      expect(first.token).toMatch(/^jwt\.risk-agent\.\d+$/);
      expect(first.cacheOutcome).toBe('miss');
      expect(first.expiresInSeconds).toBe(900);

      const second = await minter.mintToken('risk-agent', {
        can_start_sessions: true,
        is_observer: false,
        allowed_modes: ['macp.mode.decision.v1']
      });
      expect(second.cacheOutcome).toBe('hit');
      expect(second.token).toBe(first.token);

      expect(authMock.records).toHaveLength(1);
      const req = authMock.records[0];
      expect(req.sender).toBe('risk-agent');
      expect(req.ttl_seconds).toBe(900);
      expect(req.scopes).toEqual({
        can_start_sessions: true,
        is_observer: false,
        allowed_modes: ['macp.mode.decision.v1']
      });
    });

    it('coalesces concurrent mint calls into a single HTTP request', async () => {
      authMock.setOptions({ delayMs: 100 });
      const minter = ctx.app.get(AuthTokenMinterService);
      const scopes = { can_start_sessions: false, is_observer: false };
      const results = await Promise.all([
        minter.mintToken('fraud-agent', scopes),
        minter.mintToken('fraud-agent', scopes),
        minter.mintToken('fraud-agent', scopes),
        minter.mintToken('fraud-agent', scopes)
      ]);
      const tokens = new Set(results.map((r) => r.token));
      expect(tokens.size).toBe(1);
      expect(authMock.records).toHaveLength(1);
    });

    it('propagates 5xx as AUTH_MINT_FAILED (502)', async () => {
      authMock.setOptions({ failAll: true });
      const minter = ctx.app.get(AuthTokenMinterService);
      await expect(minter.mintToken('analyst')).rejects.toMatchObject({
        errorCode: 'AUTH_MINT_FAILED'
      });
    });
  });

  describe('Full /examples/run under jwt mode', () => {
    let ctx: IntegrationTestContext;

    beforeEach(async () => {
      ctx = await createIntegrationTestApp({
        stubAuthMinter: false,
        authServiceUrl: authMock.baseUrl,
        authServiceTimeoutMs: 3000,
        authTokenTtlSeconds: 1800,
        runtimeAddress: 'runtime.local:50051',
        autoBootstrapExampleAgents: true
      });
      // PolicyRegistrarService mints an `macp-playground` admin JWT at
      // bootstrap when runtimeAddress is set. Drop it so assertions below
      // observe only mints driven by /examples/run.
      authMock.clear();
    });

    afterEach(async () => {
      if (ctx) await ctx.cleanup();
    });

    it('mints exactly one JWT per unique participant spawn and writes it to the bootstrap', async () => {
      // Capture every bootstrap file written by the supervisor so we can
      // assert the on-disk auth_token carries the minted JWT — that is the
      // load-bearing write consumed by both SDK fromBootstrap() readers.
      const supervisor = ctx.app.get(LaunchSupervisor);
      const writeSpy = jest.spyOn(supervisor, 'writeBootstrapFile');

      await ctx.client.runExample(fraudScenarioRunRequest());

      // Four participants in the fraud scenario → four unique mints.
      const senders = authMock.records.map((r) => r.sender).sort();
      expect(senders).toEqual(['compliance-agent', 'fraud-agent', 'growth-agent', 'risk-agent']);

      // Initiator scope sanity: exactly one request should have
      // can_start_sessions=true, the rest false. Initiator identity comes
      // from scenario templates; we don't hard-code it here.
      const startAllowed = authMock.records.filter((r) => {
        const scopes = r.scopes as { can_start_sessions?: boolean } | undefined;
        return scopes?.can_start_sessions === true;
      });
      const startDenied = authMock.records.filter((r) => {
        const scopes = r.scopes as { can_start_sessions?: boolean } | undefined;
        return scopes?.can_start_sessions === false;
      });
      expect(startAllowed).toHaveLength(1);
      expect(startDenied).toHaveLength(3);

      // Every mint should request the scenario mode and the configured TTL.
      // The trailing empty string in allowed_modes is load-bearing: it grants
      // ambient-envelope (Signal/Progress) authorization at the runtime, which
      // has no mode field. See deriveScopes() in process-example-agent-host.provider.ts.
      for (const record of authMock.records) {
        expect(record.ttl_seconds).toBe(1800);
        const scopes = record.scopes as { allowed_modes?: string[] } | undefined;
        expect(scopes?.allowed_modes).toEqual(['macp.mode.decision.v1', '']);
      }

      // E2E proof: the minted JWT actually reached bootstrap.auth_token.
      const bootstraps = writeSpy.mock.calls.map((call) => call[0] as BootstrapPayload);
      expect(bootstraps).toHaveLength(4);
      for (const bootstrap of bootstraps) {
        expect(bootstrap.auth_token).toMatch(
          new RegExp(`^jwt\\.${bootstrap.participant_id}\\.\\d+$`)
        );
      }
    });
  });

  describe('Full /examples/run under jwt mode — auth-service down', () => {
    let ctx: IntegrationTestContext;

    beforeEach(async () => {
      authMock.setOptions({ failAll: true });
      ctx = await createIntegrationTestApp({
        stubAuthMinter: false,
        authServiceUrl: authMock.baseUrl,
        authServiceTimeoutMs: 2000,
        runtimeAddress: 'runtime.local:50051',
        autoBootstrapExampleAgents: true
      });
    });

    afterEach(async () => {
      if (ctx) await ctx.cleanup();
    });

    it('surfaces AUTH_MINT_FAILED (HTTP 502) through /examples/run', async () => {
      const raw = await ctx.client.requestRaw('POST', '/examples/run', {
        body: fraudScenarioRunRequest()
      });
      expect(raw.status).toBe(502);
      const body = raw.body as { errorCode?: string };
      expect(body.errorCode).toBe('AUTH_MINT_FAILED');
    });
  });

});
