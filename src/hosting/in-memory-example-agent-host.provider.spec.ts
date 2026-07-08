import { ExampleAgentDefinition, ExampleAgentRunContext, ParticipantAgentBinding } from '../contracts/example-agents';
import { InMemoryExampleAgentHostProvider } from './in-memory-example-agent-host.provider';

describe('InMemoryExampleAgentHostProvider', () => {
  const provider = new InMemoryExampleAgentHostProvider();

  const definition: ExampleAgentDefinition = {
    agentRef: 'fraud-agent',
    name: 'Fraud Sentinel',
    role: 'fraud',
    description: 'Detects fraudulent transactions',
    framework: 'langgraph',
    bootstrap: {
      strategy: 'external',
      entrypoint: 'agents/langgraph_worker/main.py',
      transportIdentity: 'agent://fraud-agent',
      mode: 'deferred',
      launcher: 'python',
      notes: ['demo agent']
    },
    tags: ['fraud', 'demo']
  };

  const binding: ParticipantAgentBinding = {
    participantId: 'participant-fraud',
    role: 'fraud-analyst',
    agentRef: 'fraud-agent'
  };

  const context: ExampleAgentRunContext = {
    runId: 'run-42',
    sessionId: '00000000-0000-4000-8000-000000000001',
    scenarioRef: 'fraud/high-value-new-device@1.0.0',
    modeName: 'macp.mode.decision.v1',
    modeVersion: '1.0.0',
    configurationVersion: 'config.default',
    ttlMs: 300000,
    participants: ['participant-fraud']
  };

  it('resolve() returns a preview-hosted agent combining definition and binding fields', async () => {
    const hosted = await provider.resolve(definition, binding);

    expect(hosted).toMatchObject({
      participantId: 'participant-fraud',
      agentRef: 'fraud-agent',
      name: 'Fraud Sentinel',
      role: 'fraud-analyst',
      framework: 'langgraph',
      transportIdentity: 'agent://fraud-agent',
      entrypoint: 'agents/langgraph_worker/main.py',
      bootstrapStrategy: 'external',
      bootstrapMode: 'deferred',
      status: 'resolved',
      notes: ['demo agent'],
      tags: ['fraud', 'demo']
    });
    expect(hosted.participantMetadata).toMatchObject({ hostMode: 'preview', launcher: 'python' });
    expect(hosted.participantMetadata).not.toHaveProperty('attachedRunId');
  });

  it('attach() marks the agent bootstrapped and records the attached run', async () => {
    const hosted = await provider.attach(definition, binding, context);

    expect(hosted.status).toBe('bootstrapped');
    expect(hosted.participantMetadata).toMatchObject({
      hostMode: 'in-memory',
      attachedRunId: 'run-42',
      role: 'fraud-analyst',
      agentRef: 'fraud-agent',
      framework: 'langgraph'
    });
  });

  it('uses the binding role (not the definition role) for hosted metadata', async () => {
    const hosted = await provider.resolve(definition, { ...binding, role: 'observer' });

    expect(hosted.role).toBe('observer');
    expect(hosted.participantMetadata).toMatchObject({ role: 'observer' });
  });
});
