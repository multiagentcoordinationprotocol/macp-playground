import { createIntegrationTestApp, IntegrationTestContext } from '../helpers/integration-test-app';
import { fraudScenarioRunRequest } from '../fixtures/integration-requests';

/**
 * LLM launch limits through the real HTTP stack (AppModule, guards, controller, ExampleRunService,
 * LlmBudgetService, in-memory store), with the console's X-MACP-Client-IP header. The Postgres store
 * is exercised by its own spec against a real database.
 */
const describeIfMock = (process.env.INTEGRATION_CONTROL_PLANE ?? 'mock') === 'mock' ? describe : describe.skip;

const KEY = 'console-key';

interface RunBody {
  compiled: { scenarioMeta: { agentExecution?: string; agentExecutionFallback?: { reason: string; limit: string } } };
}

describeIfMock('LLM launch limits (integration, mock-only)', () => {
  describe('LLM_LIMIT_ACTION=fallback', () => {
    let ctx: IntegrationTestContext;

    beforeAll(async () => {
      ctx = await createIntegrationTestApp({
        authApiKeys: [KEY],
        allowLlmAgents: true,
        llmBudget: { perIpBurst: 2, perIpDaily: 3, globalDaily: 4, globalMonthly: 100, onLimit: 'fallback' }
      });
    });
    afterAll(async () => {
      if (ctx) await ctx.cleanup();
    });

    const launch = async (clientIp?: string) => {
      const res = await ctx.client.requestRaw('POST', '/examples/run', {
        body: fraudScenarioRunRequest({ submitToControlPlane: false }),
        headers: { 'x-api-key': KEY, ...(clientIp ? { 'x-macp-client-ip': clientIp } : {}) }
      });
      expect(res.status).toBe(201);
      return (res.body as RunBody).compiled.scenarioMeta;
    };

    it('trips the per-IP burst limit for one end user and falls back to marked deterministic agents', async () => {
      expect((await launch('203.0.113.1')).agentExecution).toBe('llm');
      expect((await launch('203.0.113.1')).agentExecution).toBe('llm');
      const third = await launch('203.0.113.1');
      expect(third.agentExecution).toBe('deterministic');
      expect(third.agentExecutionFallback).toEqual({ reason: 'llm_limit', limit: 'per_ip_burst' });
    });

    it('keeps other end users behind the same proxy unaffected, until the global daily cap trips for everyone', async () => {
      expect((await launch('203.0.113.2')).agentExecution).toBe('llm');
      expect((await launch('203.0.113.3')).agentExecution).toBe('llm'); // 4th granted launch: cap reached
      const capped = await launch('203.0.113.4');
      expect(capped.agentExecution).toBe('deterministic');
      expect(capped.agentExecutionFallback).toEqual({ reason: 'llm_limit', limit: 'global_daily' });
    });

    it('reports global counts on the keyed /llm-usage route, and nothing on /healthz', async () => {
      const usage = await ctx.client.requestRaw('GET', '/llm-usage', { headers: { 'x-api-key': KEY } });
      expect(usage.status).toBe(200);
      expect(usage.body).toMatchObject({ store: 'memory', onLimit: 'fallback', globalDaily: { count: 4, limit: 4 } });
      expect(JSON.stringify(usage.body)).not.toMatch(/203\.0\.113/);

      expect((await ctx.client.requestRaw('GET', '/llm-usage')).status).toBe(401);
      expect((await ctx.client.requestRaw('GET', '/healthz')).body).toEqual({ ok: true, service: 'macp-playground' });
    });
  });

  describe('LLM_LIMIT_ACTION=reject', () => {
    let ctx: IntegrationTestContext;

    beforeAll(async () => {
      ctx = await createIntegrationTestApp({
        authApiKeys: [KEY],
        allowLlmAgents: true,
        llmBudget: { perIpBurst: 1, onLimit: 'reject' }
      });
    });
    afterAll(async () => {
      if (ctx) await ctx.cleanup();
    });

    it('refuses the launch over the limit with 429 LLM_LIMIT_EXCEEDED', async () => {
      const send = () =>
        ctx.client.requestRaw('POST', '/examples/run', {
          body: fraudScenarioRunRequest({ submitToControlPlane: false }),
          headers: { 'x-api-key': KEY, 'x-macp-client-ip': '198.51.100.7' }
        });
      expect((await send()).status).toBe(201);
      const refused = await send();
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ errorCode: 'LLM_LIMIT_EXCEEDED', metadata: { limit: 'per_ip_burst' } });
    });
  });
});
