import { createIntegrationTestApp, IntegrationTestContext } from '../helpers/integration-test-app';
import {
  fraudScenarioRunRequest,
  lendingScenarioRunRequest,
  claimsScenarioRunRequest
} from '../fixtures/integration-requests';

// CP-1 submission is only observable through MockControlPlane, which only
// exists in `mock` mode (`test/helpers/integration-test-app.ts` leaves
// `mockControlPlane` null and `controlPlaneUrl` unset in `docker`/`remote`
// mode). Without this guard, `describe.skip` at load time isn't possible
// (ctx isn't populated until beforeAll), so these blocks would run in
// docker/remote mode too and fail on `ctx.mockControlPlane` being null
// rather than being skipped as not-applicable.
const controlPlaneMode = process.env.INTEGRATION_CONTROL_PLANE ?? 'mock';
const describeMockOnly = controlPlaneMode === 'mock' ? describe : describe.skip;

describe('Example Run (integration)', () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await createIntegrationTestApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('POST /examples/run', () => {
    it('completes full flow: compile + bootstrap agents', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest())) as any;

      expect(result.compiled).toBeDefined();
      expect(result.compiled.runDescriptor).toBeDefined();
      expect(result.compiled.mode).toBe('sandbox');
      expect(result.compiled.runDescriptor.session.modeName).toBe('macp.mode.decision.v1');
      expect(result.sessionId).toBeDefined();
      expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('returns hosted agents with bootstrap metadata', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest())) as any;

      expect(result.hostedAgents).toHaveLength(4);
      for (const agent of result.hostedAgents) {
        expect(agent.transportIdentity).toContain('agent://');
        expect(agent.participantId).toBeDefined();
        expect(agent.framework).toBeDefined();
        expect(agent.entrypoint).toBeDefined();
        expect(agent.bootstrapStrategy).toBeDefined();
      }

      const frameworks = result.hostedAgents.map((a: any) => a.framework).sort();
      expect(frameworks).toEqual(['crewai', 'custom', 'langchain', 'langgraph']);
    });
  });

  describe('Cross-pack runs', () => {
    it('runs lending scenario', async () => {
      const result = (await ctx.client.runExample(lendingScenarioRunRequest())) as any;

      expect(result.sessionId).toBeDefined();
      expect(result.compiled.scenarioMeta.sessionContext.loanAmount).toBe(25000);
    });

    it('runs claims scenario', async () => {
      const result = (await ctx.client.runExample(claimsScenarioRunRequest())) as any;

      expect(result.sessionId).toBeDefined();
      expect(result.compiled.scenarioMeta.sessionContext.claimAmount).toBe(8500);
    });
  });

  describeMockOnly('CP-1 run submission (POST /runs)', () => {
    beforeEach(() => {
      ctx.mockControlPlane?.clearRequests();
    });

    it('submits exactly one createRun request whose sessionId matches the response', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest())) as any;

      expect(ctx.mockControlPlane?.createRunRequests).toHaveLength(1);
      const submitted = ctx.mockControlPlane!.createRunRequests[0].body as any;
      expect(submitted.session.sessionId).toBe(result.sessionId);
      expect(submitted.mode).toBe('sandbox');
      expect(submitted.session.modeName).toBe('macp.mode.decision.v1');

      // The mock's 201 response is surfaced back on the result.
      expect(result.controlPlaneRun).toBeDefined();
      expect(result.controlPlaneRun.sessionId).toBe(result.sessionId);
    });

    it('never re-introduces the deleted control-plane write paths (observer invariant)', async () => {
      await ctx.client.runExample(fraudScenarioRunRequest());

      expect(ctx.mockControlPlane?.agentWriteRequests).toHaveLength(0);
    });
  });

  describeMockOnly('CP-1 auth header (happy path)', () => {
    let authenticatedCtx: IntegrationTestContext;

    beforeAll(async () => {
      // Unlike the "CP-1 auth rejection" context below, this one configures
      // matching credentials on both sides — the shape docker-compose.fullstack.yml
      // actually ships (AUTH_API_KEYS: demo-key / MACP_CONTROL_PLANE_API_KEY: demo-key).
      // Only the *failing* auth path had coverage before this test existed.
      authenticatedCtx = await createIntegrationTestApp({
        mockControlPlaneOptions: { requiredBearerToken: 'demo-key' },
        controlPlaneApiKey: 'demo-key'
      });
    });

    afterAll(async () => {
      if (authenticatedCtx) await authenticatedCtx.cleanup();
    });

    it('sends Authorization: Bearer <key> and the control-plane accepts the submission', async () => {
      const result = (await authenticatedCtx.client.runExample(fraudScenarioRunRequest())) as any;

      expect(authenticatedCtx.mockControlPlane?.createRunRequests).toHaveLength(1);
      expect(authenticatedCtx.mockControlPlane!.createRunRequests[0].headers['authorization']).toBe(
        'Bearer demo-key'
      );
      expect(result.controlPlaneRun).toBeDefined();
    });
  });

  describeMockOnly('CP-1 submission skipped when controlPlaneUrl is unset', () => {
    let noUrlCtx: IntegrationTestContext;

    beforeAll(async () => {
      noUrlCtx = await createIntegrationTestApp({ controlPlaneUrl: '' });
    });

    afterAll(async () => {
      if (noUrlCtx) await noUrlCtx.cleanup();
    });

    it('never calls the control-plane and still completes the launch', async () => {
      const result = (await noUrlCtx.client.runExample(fraudScenarioRunRequest())) as any;

      expect(result.hostedAgents).toHaveLength(4);
      expect(result.controlPlaneRun).toBeUndefined();
      // This ctx's own mock never receives a request (it exists only so
      // clearRequests/createRunRequests are available; controlPlaneUrl is
      // explicitly unset above, independent of where the mock listens).
      expect(noUrlCtx.mockControlPlane?.createRunRequests).toHaveLength(0);
    });
  });

  describeMockOnly('CP-1 auth rejection is non-fatal', () => {
    let rejectingCtx: IntegrationTestContext;

    beforeAll(async () => {
      rejectingCtx = await createIntegrationTestApp({
        mockControlPlaneOptions: { requiredBearerToken: 'demo-key' }
        // controlPlaneApiKey intentionally left unset — client sends no
        // Authorization header, so the mock's bearer check 401s the request.
      });
    });

    afterAll(async () => {
      if (rejectingCtx) await rejectingCtx.cleanup();
    });

    it('still bootstraps agents and returns 2xx when the control-plane rejects the submission', async () => {
      const result = (await rejectingCtx.client.runExample(fraudScenarioRunRequest())) as any;

      expect(result.hostedAgents).toHaveLength(4);
      expect(result.sessionId).toBeDefined();
      expect(result.controlPlaneRun).toBeUndefined();
      // The mock still recorded the attempt — it just rejected it with 401.
      expect(rejectingCtx.mockControlPlane?.createRunRequests).toHaveLength(1);
    });
  });

  describe('Direct-agent-auth (ES-9)', () => {
    it('pre-allocates a UUID v4 sessionId and threads it through runDescriptor', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest())) as any;

      const sessionId = result.compiled.sessionId;
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(result.compiled.runDescriptor.session.sessionId).toBe(sessionId);
    });

    it('emits a scenario-agnostic runDescriptor with no policyHints / kickoff / commitments', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest())) as any;

      const descriptor = result.compiled.runDescriptor;
      expect(descriptor.session.modeName).toBe('macp.mode.decision.v1');
      expect(descriptor.session.participants).toHaveLength(4);
      expect(descriptor.session.policyHints).toBeUndefined();
      expect(descriptor.session.commitments).toBeUndefined();
      expect(descriptor.session.initiatorParticipantId).toBeUndefined();
      expect(descriptor.kickoff).toBeUndefined();
    });

    it('produces an initiator payload targeted at exactly one participant', async () => {
      const result = (await ctx.client.runExample(fraudScenarioRunRequest())) as any;

      expect(result.compiled.initiator).toBeDefined();
      expect(result.compiled.initiator.participantId).toBe(result.compiled.scenarioMeta.initiatorParticipantId);
      expect(result.compiled.initiator.sessionStart.participants).toEqual(
        result.compiled.runDescriptor.session.participants.map((p: any) => p.id)
      );
      expect(result.compiled.initiator.kickoff).toBeDefined();
    });
  });
});
