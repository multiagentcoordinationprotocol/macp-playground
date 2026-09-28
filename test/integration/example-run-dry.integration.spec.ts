import { createIntegrationTestApp, IntegrationTestContext } from '../helpers/integration-test-app';
import {
  fraudScenarioRunRequest,
  lendingScenarioRunRequest,
  claimsScenarioRunRequest
} from '../fixtures/integration-requests';

describe('Example Run - Dry Run (integration)', () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await createIntegrationTestApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('POST /examples/run with bootstrapAgents=false', () => {
    it('compiles and returns empty hostedAgents without bootstrapping', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest({ bootstrapAgents: false }))) as any;

      expect(result.compiled).toBeDefined();
      expect(result.compiled.runDescriptor).toBeDefined();
      expect(result.hostedAgents).toHaveLength(0);
      expect(result.sessionId).toBeUndefined();
    });
  });

  describe('POST /examples/run (with bootstrap)', () => {
    it('resolves 4 hosted agents with correct frameworks', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest())) as any;

      expect(result.hostedAgents).toHaveLength(4);
      const frameworks = result.hostedAgents.map((a: any) => a.framework).sort();
      expect(frameworks).toEqual(['crewai', 'custom', 'langchain', 'langgraph']);
    });

    it('each hosted agent has transport identity and metadata', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest())) as any;

      for (const agent of result.hostedAgents) {
        expect(agent.transportIdentity).toContain('agent://');
        expect(agent.participantId).toBeDefined();
        expect(agent.agentRef).toBeDefined();
        expect(agent.framework).toBeDefined();
        expect(agent.entrypoint).toBeDefined();
        expect(agent.bootstrapStrategy).toBeDefined();
        expect(agent.bootstrapMode).toBeDefined();
        expect(agent.status).toBeDefined();
      }
    });
  });

  describe('Cross-pack runs', () => {
    it('lending scenario resolves 4 agents with correct context', async () => {
      const result = (await ctx.client.runExample(lendingScenarioRunRequest())) as any;

      expect(result.hostedAgents).toHaveLength(4);
      expect(result.compiled.scenarioMeta.sessionContext.loanAmount).toBe(25000);
      expect(result.sessionId).toBeDefined();
    });

    it('claims scenario resolves 4 agents with correct context', async () => {
      const result = (await ctx.client.runExample(claimsScenarioRunRequest())) as any;

      expect(result.hostedAgents).toHaveLength(4);
      expect(result.compiled.scenarioMeta.sessionContext.claimAmount).toBe(8500);
      expect(result.sessionId).toBeDefined();
    });
  });
});
