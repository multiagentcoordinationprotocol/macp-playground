import { ExampleAgentCatalogService } from '../example-agents/example-agent-catalog.service';
import { CompileLaunchResult } from '../contracts/launch';
import { ExampleAgentRunContext } from '../contracts/example-agents';
import { HostingService } from './hosting.service';
import { InMemoryExampleAgentHostProvider } from './in-memory-example-agent-host.provider';

describe('HostingService', () => {
  let service: HostingService;

  beforeEach(() => {
    service = new HostingService(new ExampleAgentCatalogService(), new InMemoryExampleAgentHostProvider());
  });

  const sessionId = '00000000-0000-4000-8000-000000000001';

  function buildCompiled(): CompileLaunchResult {
    return {
      sessionId,
      mode: 'sandbox',
      runDescriptor: {
        mode: 'sandbox',
        runtime: { kind: 'rust' },
        session: {
          sessionId,
          modeName: 'macp.mode.decision.v1',
          modeVersion: '1.0.0',
          configurationVersion: 'config.default',
          ttlMs: 300000,
          participants: [
            { id: 'fraud-agent' },
            { id: 'growth-agent' },
            { id: 'compliance-agent' },
            { id: 'risk-agent' }
          ]
        }
      },
      scenarioMeta: {
        initiatorParticipantId: 'risk-agent'
      },
      display: {
        title: 'Fraud',
        scenarioRef: 'fraud/high-value-new-device@1.0.0'
      },
      participantBindings: [
        { participantId: 'fraud-agent', role: 'fraud', agentRef: 'fraud-agent' },
        { participantId: 'growth-agent', role: 'growth', agentRef: 'growth-agent' },
        { participantId: 'compliance-agent', role: 'compliance', agentRef: 'compliance-agent' },
        { participantId: 'risk-agent', role: 'risk', agentRef: 'risk-agent' }
      ]
    };
  }

  it('resolves example agents and records hosted-participant metadata', async () => {
    const compiled = buildCompiled();

    const hosted = await service.resolve(compiled);

    expect(hosted).toHaveLength(4);
    expect(hosted.every((agent) => agent.status === 'resolved')).toBe(true);
    const hostedParticipants = compiled.runDescriptor.session.metadata?.hostedParticipants as Array<{
      participantId: string;
      transportIdentity: string;
      framework: string;
    }>;
    expect(hostedParticipants).toHaveLength(4);
    expect(hostedParticipants[0].transportIdentity).toBe('agent://fraud-agent');
    expect(hostedParticipants[2].framework).toBe('crewai');
  });

  it('attaches example agents after a run is created', async () => {
    const compiled = buildCompiled();
    const context: ExampleAgentRunContext = {
      runId: 'run-1',
      sessionId,
      traceId: 'trace-1',
      scenarioRef: 'fraud/high-value-new-device@1.0.0',
      modeName: 'macp.mode.decision.v1',
      modeVersion: '1.0.0',
      configurationVersion: 'config.default',
      ttlMs: 300000,
      participants: compiled.runDescriptor.session.participants.map((participant) => participant.id),
      initiatorParticipantId: 'risk-agent'
    };

    const hosted = await service.attach(compiled, context);

    expect(hosted).toHaveLength(4);
    expect(hosted.every((agent) => agent.status === 'bootstrapped')).toBe(true);
    const hostedParticipants = compiled.runDescriptor.session.metadata?.hostedParticipants as Array<{
      participantMetadata: { attachedRunId?: string };
    }>;
    expect(hostedParticipants[3].participantMetadata.attachedRunId).toBe('run-1');
  });

  // RFC-MACP-0004 §4: the macp-playground service pre-allocates a single sessionId and
  // threads it into every AgentBootstrap. If attach() regressed to minting a
  // per-participant sessionId (for example by calling randomUUID() inside the
  // loop), agents would each join a different session. This test pins down the
  // invariant by recording the sessionId seen by each participant's bootstrap.
  it('passes the same sessionId to every participant bootstrap in a multi-agent attach', async () => {
    const recordingProvider = new InMemoryExampleAgentHostProvider();
    const seenSessionIds: string[] = [];
    const originalAttach = recordingProvider.attach!.bind(recordingProvider);
    recordingProvider.attach = async (definition, binding, ctx) => {
      seenSessionIds.push(ctx.sessionId ?? '(undefined)');
      return originalAttach(definition, binding, ctx);
    };

    const recordingService = new HostingService(new ExampleAgentCatalogService(), recordingProvider);
    const compiled = buildCompiled();
    const context: ExampleAgentRunContext = {
      runId: sessionId,
      sessionId,
      scenarioRef: compiled.display.scenarioRef,
      modeName: 'macp.mode.decision.v1',
      modeVersion: '1.0.0',
      configurationVersion: 'config.default',
      ttlMs: 300000,
      participants: compiled.runDescriptor.session.participants.map((p) => p.id),
      initiatorParticipantId: 'risk-agent'
    };

    await recordingService.attach(compiled, context);

    expect(seenSessionIds).toHaveLength(4);
    expect(new Set(seenSessionIds).size).toBe(1);
    expect(seenSessionIds[0]).toBe(sessionId);
  });
});
