import { createIntegrationTestApp, IntegrationTestContext } from '../helpers/integration-test-app';
import { IntegrationTestClient } from '../helpers/integration-test-client';
import { fraudScenarioRunRequest } from '../fixtures/integration-requests';

const describeIfMock = (process.env.INTEGRATION_CONTROL_PLANE ?? 'mock') === 'mock' ? describe : describe.skip;

describeIfMock('API Key Authentication (integration, mock-only)', () => {
  describe('when API keys are configured', () => {
    let ctx: IntegrationTestContext;

    beforeAll(async () => {
      ctx = await createIntegrationTestApp({ authApiKeys: ['test-key-1', 'test-key-2'] });
    });

    afterAll(async () => {
      if (ctx) await ctx.cleanup();
    });

    afterEach(() => {
      ctx.mockControlPlane!.clearRequests();
    });

    it('rejects requests without x-api-key header with 401', async () => {
      const { status, body } = await ctx.client.requestRaw('GET', '/healthz');
      expect(status).toBe(401);
      expect((body as Record<string, unknown>).message).toContain('API key');
    });

    it('rejects requests with invalid x-api-key header with 401', async () => {
      const { status } = await ctx.client.requestRaw('GET', '/healthz', {
        headers: { 'x-api-key': 'wrong-key' }
      });
      expect(status).toBe(401);
    });

    it('accepts requests with valid x-api-key (first key)', async () => {
      const { status } = await ctx.client.requestRaw('GET', '/healthz', {
        headers: { 'x-api-key': 'test-key-1' }
      });
      expect(status).toBe(200);
    });

    it('accepts requests with valid x-api-key (second key)', async () => {
      const { status } = await ctx.client.requestRaw('GET', '/packs', {
        headers: { 'x-api-key': 'test-key-2' }
      });
      expect(status).toBe(200);
    });

    it('rejects POST endpoints without api key', async () => {
      const { status } = await ctx.client.requestRaw('POST', '/examples/run', {
        body: fraudScenarioRunRequest()
      });
      expect(status).toBe(401);
    });

    it('allows POST endpoints with valid api key via IntegrationTestClient', async () => {
      const authedClient = new IntegrationTestClient(ctx.url, 'test-key-1');
      const result = await authedClient.runExample(fraudScenarioRunRequest());
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>).compiled).toBeDefined();
    });
  });

  describe('when no API keys are configured (open access)', () => {
    let ctx: IntegrationTestContext;

    beforeAll(async () => {
      ctx = await createIntegrationTestApp({ authApiKeys: [] });
    });

    afterAll(async () => {
      if (ctx) await ctx.cleanup();
    });

    it('allows requests without x-api-key header', async () => {
      const { status } = await ctx.client.requestRaw('GET', '/healthz');
      expect(status).toBe(200);
    });

    it('allows catalog browsing without key', async () => {
      const { status } = await ctx.client.requestRaw('GET', '/packs');
      expect(status).toBe(200);
    });
  });
});
