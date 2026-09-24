import { Logger } from '@nestjs/common';
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

  it('falls back to a freshly-generated UUID and mirrors it into runDescriptor.session.sessionId when compiled.sessionId is falsy', async () => {
    // Defense-in-depth: CompileLaunchResult.sessionId is typed as required
    // and CompilerService always populates it today, so this path isn't
    // reachable via the shipped compiler — but nothing in the type system
    // stops a future CompilerService change (or a hand-built
    // CompileLaunchResult in a test/tool) from violating that contract, and
    // the `|| randomUUID()` fallback exists specifically to keep run()
    // correct if it ever does. This pins that: (1) the fallback actually
    // generates a fresh UUID rather than passing an empty string through,
    // and (2) it's mirrored into runDescriptor.session.sessionId (the field
    // that was fixed to also stay in sync in this hardening pass) —
    // otherwise the CP-1 submission would carry an empty/undefined
    // sessionId while every other caller sees the freshly-generated one.
    compiler.compile.mockImplementation(async () => {
      const c = buildCompiled();
      c.sessionId = '';
      c.runDescriptor.session.sessionId = '';
      return c;
    });
    controlPlaneClient.submitRun.mockResolvedValue(null);

    const result = await service.run({
      scenarioRef: 'fraud/high-value-new-device@1.0.0',
      inputs: {}
    });

    expect(result.sessionId).toBeDefined();
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.compiled.runDescriptor.session.sessionId).toBe(result.sessionId);
    expect(controlPlaneClient.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ sessionId: result.sessionId }) })
    );
    expect(hosting.attach).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: result.sessionId }),
      expect.objectContaining({ sessionId: result.sessionId })
    );
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

    it('logs and continues when submitRun rejects with a non-Error value', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      controlPlaneClient.submitRun.mockRejectedValue('some non-Error rejection');

      const result = await service.run({
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        inputs: {}
      });

      expect(result.controlPlaneRun).toBeUndefined();
      expect(result.hostedAgents).toEqual(attachedAgents);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reason=unknown error'));
      warnSpy.mockRestore();
    });

    it('still rejects run() when hosting.attach fails, independent of control-plane outcome', async () => {
      hosting.attach.mockRejectedValue(new Error('bootstrap failed'));
      controlPlaneClient.submitRun.mockResolvedValue(controlPlaneResponse);

      await expect(service.run({ scenarioRef: 'fraud/high-value-new-device@1.0.0', inputs: {} })).rejects.toThrow(
        'bootstrap failed'
      );
    });

    it('submits the resolve-stage snapshot even though hosting.attach mutates session.metadata again concurrently', async () => {
      // Regression test for the race-condition fix in example-run.service.ts.
      // In production (HostingService.applyHostedAgents), BOTH resolve() and
      // attach() mutate compiled.runDescriptor.session.metadata in place —
      // resolve() runs (and mutates) synchronously before the clone is taken;
      // attach() then mutates the *same underlying object* again concurrently
      // with submitRun(), racing on it. Before the structuredClone fix, that
      // race could leak attach's later mutation into the submitted
      // descriptor depending on interleaving. This pins that submitRun always
      // receives the resolve-stage snapshot — never attach's later one —
      // regardless of interleaving. (A prior version of this test mocked
      // resolve() as a no-op and asserted metadata was simply undefined,
      // which doesn't hold in production: resolve() always populates
      // hostedParticipants before the clone is ever taken.)
      hosting.resolve.mockImplementation(async (compiledArg) => {
        compiledArg.runDescriptor.session.metadata = {
          ...(compiledArg.runDescriptor.session.metadata ?? {}),
          hostedParticipants: ['resolve-stage']
        };
        return resolvedAgents;
      });
      hosting.attach.mockImplementation(async (compiledArg) => {
        compiledArg.runDescriptor.session.metadata = {
          ...(compiledArg.runDescriptor.session.metadata ?? {}),
          hostedParticipants: ['attach-stage']
        };
        return attachedAgents;
      });
      controlPlaneClient.submitRun.mockResolvedValue(controlPlaneResponse);

      await service.run({ scenarioRef: 'fraud/high-value-new-device@1.0.0', inputs: {} });

      const submittedDescriptor = controlPlaneClient.submitRun.mock.calls[0][0];
      expect(submittedDescriptor.session.metadata?.hostedParticipants).toEqual(['resolve-stage']);
    });

    it('submits a descriptor that already reflects request overrides (tags/requester/runLabel)', async () => {
      controlPlaneClient.submitRun.mockResolvedValue(controlPlaneResponse);

      await service.run({
        scenarioRef: 'fraud/high-value-new-device@1.0.0',
        inputs: {},
        tags: ['extra-tag'],
        requester: { actorId: 'qa-bot', actorType: 'service' },
        runLabel: 'nightly-2026-04-15'
      });

      const submittedDescriptor = controlPlaneClient.submitRun.mock.calls[0][0];
      expect(submittedDescriptor.execution?.tags).toEqual(expect.arrayContaining(['extra-tag']));
      expect(submittedDescriptor.execution?.requester).toEqual({ actorId: 'qa-bot', actorType: 'service' });
      expect(submittedDescriptor.session.metadata?.runLabel).toBe('nightly-2026-04-15');
    });
  });

  describe('agent attach failures (PG-1)', () => {
    // Regression coverage: /examples/run used to resolve successfully (HTTP
    // 201) even when hosting.attach() reported an agent that never actually
    // attached — hosting.attach() never rejects for that case, it just
    // downgrades that agent's own `status` to 'resolved' (see
    // process-example-agent-host.provider.ts). Nothing previously inspected
    // that per-agent status before building the response.
    it('rejects run() when an attached-mode agent failed to attach', async () => {
      hosting.attach.mockResolvedValue([
        {
          ...resolvedAgents[0],
          status: 'resolved',
          participantMetadata: { processAttached: false, spawnError: 'spawn error: spawn python3 ENOENT' }
        }
      ]);

      await expect(service.run({ scenarioRef: 'fraud/high-value-new-device@1.0.0', inputs: {} })).rejects.toMatchObject(
        {
          errorCode: 'AGENT_ATTACH_FAILED'
        }
      );
    });

    it('includes the participant id and reason in the thrown error message', async () => {
      hosting.attach.mockResolvedValue([
        {
          ...resolvedAgents[0],
          status: 'resolved',
          participantMetadata: { processAttached: false, spawnError: 'spawn error: spawn python3 ENOENT' }
        }
      ]);

      await expect(service.run({ scenarioRef: 'fraud/high-value-new-device@1.0.0', inputs: {} })).rejects.toThrow(
        /risk-agent.*spawn error: spawn python3 ENOENT/
      );
    });

    it('does not reject when a mock/deferred-mode agent is legitimately never attached', async () => {
      hosting.attach.mockResolvedValue([
        {
          ...resolvedAgents[0],
          bootstrapMode: 'deferred',
          status: 'bootstrapped',
          participantMetadata: { processAttached: false, attachmentMode: 'deferred' }
        }
      ]);

      const result = await service.run({ scenarioRef: 'fraud/high-value-new-device@1.0.0', inputs: {} });

      expect(result.hostedAgents[0].participantMetadata?.attachmentMode).toBe('deferred');
    });

    it('does not reject when all attached-mode agents report bootstrapped', async () => {
      await expect(
        service.run({ scenarioRef: 'fraud/high-value-new-device@1.0.0', inputs: {} })
      ).resolves.toMatchObject({ hostedAgents: attachedAgents });
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
