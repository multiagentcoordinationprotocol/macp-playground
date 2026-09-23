import { AppConfigService } from '../config/app-config.service';
import { CompileLaunchResult } from '../contracts/launch';
import { RunDescriptorResponse } from '../contracts/run-descriptor';
import { CompilerService } from '../compiler/compiler.service';
import { HostedExampleAgent } from '../contracts/example-agents';
import { HostingService } from '../hosting/hosting.service';
import { ControlPlaneRunClient } from './control-plane-run-client.service';
import { ExampleRunService } from './example-run.service';

describe('ExampleRunService', () => {
  let service: ExampleRunService;
  let compiler: jest.Mocked<CompilerService>;
  let hosting: jest.Mocked<HostingService>;
  let config: AppConfigService;
  let controlPlaneClient: jest.Mocked<ControlPlaneRunClient>;

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
          policyVersion: 'policy.default',
          ttlMs: 300000,
          participants: [{ id: 'risk-agent' }]
        }
      },
      initiator: {
        participantId: 'risk-agent',
        sessionStart: {
          intent: 'fraud/high-value-new-device',
          participants: ['risk-agent'],
          ttlMs: 300000,
          modeVersion: '1.0.0',
          configurationVersion: 'config.default',
          policyVersion: 'policy.default'
        }
      },
      scenarioMeta: {
        initiatorParticipantId: 'risk-agent',
        policyHints: {
          type: 'none',
          description: 'No governance constraints',
          vetoThreshold: 1,
          minimumConfidence: 0.0,
          designatedRoles: []
        }
      },
      display: {
        title: 'Fraud',
        scenarioRef: 'fraud/high-value-new-device@1.0.0'
      },
      participantBindings: [{ participantId: 'risk-agent', role: 'risk', agentRef: 'risk-agent' }]
    };
  }
  const compiled = buildCompiled();

  const resolvedAgents: HostedExampleAgent[] = [
    {
      participantId: 'risk-agent',
      agentRef: 'risk-agent',
      name: 'Risk Agent',
      role: 'risk',
      framework: 'custom',
      transportIdentity: 'agent://risk-agent',
      entrypoint: 'src/example-agents/runtime/risk-decider.worker.ts',
      bootstrapStrategy: 'external',
      bootstrapMode: 'attached',
      status: 'resolved'
    }
  ];

  const attachedAgents: HostedExampleAgent[] = [
    {
      ...resolvedAgents[0],
      status: 'bootstrapped',
      participantMetadata: { attachedRunId: sessionId }
    }
  ];

  beforeEach(() => {
    // Each test gets a fresh clone so applyRequestOverrides mutations don't
    // bleed across cases.
    compiler = {
      compile: jest.fn().mockImplementation(async () => buildCompiled())
    } as unknown as jest.Mocked<CompilerService>;
    hosting = {
      resolve: jest.fn().mockResolvedValue(resolvedAgents),
      attach: jest.fn().mockResolvedValue(attachedAgents)
    } as unknown as jest.Mocked<HostingService>;
    config = {
      autoBootstrapExampleAgents: true
    } as AppConfigService;
    controlPlaneClient = {
      submitRun: jest.fn().mockResolvedValue(null)
    } as unknown as jest.Mocked<ControlPlaneRunClient>;

    service = new ExampleRunService(compiler, hosting, config, controlPlaneClient);
  });

  it('compiles and attaches agents with sessionId', async () => {
    const result = await service.run({
      scenarioRef: 'fraud/high-value-new-device@1.0.0',
      inputs: {}
    });

    expect(hosting.resolve).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    expect(hosting.attach).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId }),
      expect.objectContaining({
        runId: sessionId,
        sessionId,
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        participants: ['risk-agent'],
        initiator: compiled.initiator
      })
    );
    expect(result.hostedAgents).toEqual(attachedAgents);
    expect(result.sessionId).toBe(sessionId);
  });

  it('skips attach when bootstrapAgents is false', async () => {
    config = { autoBootstrapExampleAgents: false } as AppConfigService;
    service = new ExampleRunService(compiler, hosting, config, controlPlaneClient);

    const result = await service.run({
      scenarioRef: 'fraud/high-value-new-device@1.0.0',
      bootstrapAgents: false,
      inputs: {}
    });

    expect(hosting.resolve).not.toHaveBeenCalled();
    expect(hosting.attach).not.toHaveBeenCalled();
    expect(controlPlaneClient.submitRun).not.toHaveBeenCalled();
    expect(result.hostedAgents).toEqual([]);
    expect(result.sessionId).toBeUndefined();
  });

  describe('CP-1 run submission', () => {
    const controlPlaneResponse: RunDescriptorResponse = {
      runId: 'run-abc',
      sessionId,
      status: 'queued',
      traceId: 'trace-abc'
    };

    it('submits the compiled runDescriptor and attaches it to the result on success', async () => {
      controlPlaneClient.submitRun.mockResolvedValue(controlPlaneResponse);

      const result = await service.run({
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        inputs: {}
      });

      expect(controlPlaneClient.submitRun).toHaveBeenCalledWith(
        expect.objectContaining({ session: expect.objectContaining({ sessionId }) })
      );
      expect(result.controlPlaneRun).toEqual(controlPlaneResponse);
      // Agent bootstrap is unaffected by a successful submission either.
      expect(hosting.attach).toHaveBeenCalled();
    });

    it('omits controlPlaneRun and still attaches agents when submission returns null (unconfigured/failed)', async () => {
      controlPlaneClient.submitRun.mockResolvedValue(null);

      const result = await service.run({
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        inputs: {}
      });

      expect(result.controlPlaneRun).toBeUndefined();
      expect(result.hostedAgents).toEqual(attachedAgents);
      expect(hosting.attach).toHaveBeenCalled();
    });

    it('still attaches agents when submitRun unexpectedly rejects', async () => {
      controlPlaneClient.submitRun.mockRejectedValue(new Error('unexpected client bug'));

      const result = await service.run({
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        inputs: {}
      });

      expect(result.controlPlaneRun).toBeUndefined();
      expect(result.hostedAgents).toEqual(attachedAgents);
      expect(hosting.attach).toHaveBeenCalled();
    });

    it('still rejects run() when hosting.attach fails, independent of control-plane outcome', async () => {
      hosting.attach.mockRejectedValue(new Error('bootstrap failed'));
      controlPlaneClient.submitRun.mockResolvedValue(controlPlaneResponse);

      await expect(service.run({ scenarioRef: 'fraud/high-value-new-device@1.0.0', inputs: {} })).rejects.toThrow(
        'bootstrap failed'
      );
    });
  });

  describe('applyRequestOverrides', () => {
    it('merges tags', async () => {
      const result = await service.run({
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        inputs: {},
        tags: ['extra-tag', 'owner:qa']
      });

      const executionTags = result.compiled.runDescriptor.execution?.tags ?? [];
      expect(executionTags).toEqual(expect.arrayContaining(['extra-tag', 'owner:qa']));
    });

    it('overrides requester', async () => {
      const result = await service.run({
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        inputs: {},
        requester: { actorId: 'qa-bot', actorType: 'service' }
      });

      expect(result.compiled.runDescriptor.execution?.requester).toEqual({
        actorId: 'qa-bot',
        actorType: 'service'
      });
    });

    it('stamps runLabel', async () => {
      const result = await service.run({
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        inputs: {},
        runLabel: 'nightly-2026-04-15'
      });

      expect(result.compiled.runDescriptor.session.metadata?.runLabel).toBe('nightly-2026-04-15');
    });
  });
});
