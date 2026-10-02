import { CompilerService } from './compiler.service';
import { RegistryIndexService } from '../registry/registry-index.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { ScenarioVersionFile, ScenarioTemplateFile } from '../contracts/registry';

const mockScenario: ScenarioVersionFile = {
  apiVersion: 'scenarios.macp.dev/v1',
  kind: 'ScenarioVersion',
  metadata: { pack: 'fraud', scenario: 'test', version: '1.0.0', name: 'Test Scenario', tags: ['demo'] },
  spec: {
    runtime: { kind: 'rust', version: 'v1' },
    inputs: {
      schema: {
        type: 'object',
        properties: {
          amount: { type: 'number', default: 100, minimum: 1 },
          isVip: { type: 'boolean', default: true }
        },
        required: ['amount', 'isVip']
      }
    },
    launch: {
      modeName: 'test.mode',
      modeVersion: '1.0.0',
      configurationVersion: 'config.default',
      policyVersion: 'policy.default',
      policyHints: {
        type: 'none',
        description: 'No governance constraints',
        vetoThreshold: 1,
        minimumConfidence: 0.0,
        designatedRoles: []
      },
      ttlMs: 300000,
      initiatorParticipantId: 'agent-1',
      participants: [{ id: 'agent-1', role: 'tester', agentRef: 'agent-1' }],
      contextTemplate: {
        amount: '{{ inputs.amount }}',
        isVip: '{{ inputs.isVip }}'
      },
      metadataTemplate: {
        demoType: 'test'
      },
      kickoffTemplate: [
        {
          from: 'agent-1',
          to: ['agent-1'],
          kind: 'proposal',
          messageType: 'Proposal',
          payloadEnvelope: {
            encoding: 'json',
            json: { goal: 'test' }
          }
        }
      ]
    },
    execution: {
      tags: ['example'],
      requester: {
        actorId: 'macp-playground',
        actorType: 'service'
      }
    },
    outputs: { expectedDecisionKinds: ['approve', 'decline'] }
  }
};

const mockTemplate: ScenarioTemplateFile = {
  apiVersion: 'scenarios.macp.dev/v1',
  kind: 'ScenarioTemplate',
  metadata: { scenarioVersion: 'fraud/test@1.0.0', slug: 'strict', name: 'Strict' },
  spec: {
    defaults: { amount: 200 },
    overrides: {
      launch: {
        ttlMs: 180000,
        metadataTemplate: { demoType: 'test', posture: 'strict' }
      }
    }
  }
};

describe('CompilerService', () => {
  let service: CompilerService;
  let mockIndex: jest.Mocked<RegistryIndexService>;

  beforeEach(() => {
    mockIndex = {
      getScenarioVersion: jest.fn(),
      getTemplate: jest.fn()
    } as unknown as jest.Mocked<RegistryIndexService>;
    service = new CompilerService(mockIndex);
  });

  describe('compile - happy path', () => {
    it('should compile valid inputs into an ExecutionRequest', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 500, isVip: false }
      });

      expect(result.mode).toBe('sandbox');
      expect(result.runDescriptor.runtime).toEqual({ kind: 'rust', version: 'v1' });
      expect(result.runDescriptor.session.modeName).toBe('test.mode');
      expect(result.runDescriptor.session.policyVersion).toBe('policy.default');
      expect(result.scenarioMeta.policyHints).toEqual({
        type: 'none',
        description: 'No governance constraints',
        vetoThreshold: 1,
        minimumConfidence: 0.0,
        designatedRoles: []
      });
      expect(result.runDescriptor.session.ttlMs).toBe(300000);
      expect(result.runDescriptor.session.participants).toHaveLength(1);
      expect(result.scenarioMeta.sessionContext).toEqual({ amount: 500, isVip: false });
      expect(result.runDescriptor.session.metadata?.source).toBe('macp-playground');
      expect(result.initiator?.kickoff?.messageType).toBe('Proposal');
      expect(result.runDescriptor.execution?.tags).toEqual(['example', 'fraud', 'test', 'demo']);
      expect(result.participantBindings).toEqual([{ participantId: 'agent-1', role: 'tester', agentRef: 'agent-1' }]);
      expect(result.display.title).toBe('Test Scenario');
      expect(result.display.expectedDecisionKinds).toEqual(['approve', 'decline']);
    });

    it('should default mode to sandbox', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);
      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 100, isVip: true }
      });
      expect(result.mode).toBe('sandbox');
    });

    it('should use specified mode', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);
      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 100, isVip: true },
        mode: 'live'
      });
      expect(result.mode).toBe('live');
    });
  });

  describe('compile - merge precedence', () => {
    it('should merge: schema defaults < template defaults < user inputs', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);
      mockIndex.getTemplate.mockResolvedValue(mockTemplate);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        templateId: 'strict',
        inputs: { amount: 999, isVip: false }
      });

      expect(result.scenarioMeta.sessionContext).toEqual({ amount: 999, isVip: false });
    });

    it('should use template defaults when user does not override', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);
      mockIndex.getTemplate.mockResolvedValue(mockTemplate);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        templateId: 'strict',
        inputs: { isVip: true }
      });

      expect(result.scenarioMeta.sessionContext).toEqual({ amount: 200, isVip: true });
    });

    it('should use schema defaults when neither template nor user provides', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: {}
      });

      expect(result.scenarioMeta.sessionContext).toEqual({ amount: 100, isVip: true });
    });
  });

  describe('compile - template overrides', () => {
    it('should apply template ttlMs override', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);
      mockIndex.getTemplate.mockResolvedValue(mockTemplate);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        templateId: 'strict',
        inputs: { amount: 100, isVip: true }
      });

      expect(result.runDescriptor.session.ttlMs).toBe(180000);
    });

    it('should apply template policyVersion and policyHints override', async () => {
      const policyTemplate: ScenarioTemplateFile = {
        apiVersion: 'scenarios.macp.dev/v1',
        kind: 'ScenarioTemplate',
        metadata: { scenarioVersion: 'fraud/test@1.0.0', slug: 'majority-veto', name: 'Majority Veto' },
        spec: {
          overrides: {
            launch: {
              policyVersion: 'policy.fraud.majority-veto',
              policyHints: {
                type: 'majority',
                threshold: 0.5,
                vetoEnabled: true,
                vetoThreshold: 1,
                minimumConfidence: 0.0,
                designatedRoles: []
              }
            }
          }
        }
      };
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);
      mockIndex.getTemplate.mockResolvedValue(policyTemplate);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        templateId: 'majority-veto',
        inputs: { amount: 100, isVip: true }
      });

      expect(result.runDescriptor.session.policyVersion).toBe('policy.fraud.majority-veto');
      expect(result.scenarioMeta.policyHints).toEqual({
        type: 'majority',
        description: 'No governance constraints',
        threshold: 0.5,
        vetoEnabled: true,
        vetoThreshold: 1,
        minimumConfidence: 0.0,
        designatedRoles: []
      });
    });

    it('should merge template metadata overrides', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);
      mockIndex.getTemplate.mockResolvedValue(mockTemplate);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        templateId: 'strict',
        inputs: { amount: 100, isVip: true }
      });

      expect(result.runDescriptor.session.metadata?.posture).toBe('strict');
      expect(result.runDescriptor.session.metadata?.demoType).toBe('test');
    });
  });

  describe('compile - validation errors', () => {
    it('should throw VALIDATION_ERROR for invalid input types', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);

      try {
        await service.compile({
          scenarioRef: 'fraud/test@1.0.0',
          inputs: { amount: 'not-a-number', isVip: true }
        });
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });

    it('should throw VALIDATION_ERROR for out-of-range values', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);

      try {
        await service.compile({
          scenarioRef: 'fraud/test@1.0.0',
          inputs: { amount: -5, isVip: true }
        });
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });
  });

  describe('compile - error cases', () => {
    it('should throw INVALID_SCENARIO_REF for malformed ref', async () => {
      try {
        await service.compile({
          scenarioRef: 'bad-ref',
          inputs: {}
        });
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_SCENARIO_REF);
      }
    });

    it('should propagate SCENARIO_NOT_FOUND', async () => {
      mockIndex.getScenarioVersion.mockRejectedValue(new AppException(ErrorCode.SCENARIO_NOT_FOUND, 'not found', 404));

      await expect(service.compile({ scenarioRef: 'fraud/unknown@1.0.0', inputs: {} })).rejects.toThrow(AppException);
    });
  });

  describe('compile - runDescriptor + initiator (direct-agent-auth)', () => {
    it('emits a runDescriptor stripped of scenario-specific fields', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 500, isVip: false }
      });

      expect(result.runDescriptor.session.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(result.runDescriptor.mode).toBe('sandbox');
      expect(result.runDescriptor.session.modeName).toBe('test.mode');
      expect(result.runDescriptor.session.policyVersion).toBe('policy.default');
      expect(result.runDescriptor.session.participants).toEqual([{ id: 'agent-1' }]);
      expect(result.runDescriptor.session.ttlMs).toBe(300000);
      expect(result.runDescriptor.execution?.requester?.actorId).toBe('macp-playground');

      // Scenario-specific fields must NOT appear on the generic descriptor.
      const sessionRecord = result.runDescriptor.session as unknown as Record<string, unknown>;
      expect(sessionRecord.policyHints).toBeUndefined();
      expect(sessionRecord.commitments).toBeUndefined();
      expect(sessionRecord.initiatorParticipantId).toBeUndefined();
      expect((result.runDescriptor as unknown as Record<string, unknown>).kickoff).toBeUndefined();
    });

    it('pre-allocates a shared sessionId used by runDescriptor.session', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 100, isVip: true }
      });

      expect(result.sessionId).toBe(result.runDescriptor.session.sessionId);
    });

    it('produces an initiator payload with SessionStart + kickoff data for the initiator participant', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 100, isVip: true }
      });

      expect(result.initiator).toBeDefined();
      expect(result.initiator?.participantId).toBe('agent-1');
      expect(result.initiator?.sessionStart.participants).toEqual(['agent-1']);
      expect(result.initiator?.sessionStart.ttlMs).toBe(300000);
      expect(result.initiator?.sessionStart.modeVersion).toBe('1.0.0');
      expect(result.initiator?.kickoff?.messageType).toBe('Proposal');
      expect(result.initiator?.kickoff?.payload).toEqual({ goal: 'test' });
    });

    it('threads string (base64) extensions through to initiator.sessionStart', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue({
        ...mockScenario,
        spec: { ...mockScenario.spec, launch: { ...mockScenario.spec.launch, extensions: { 'x.trace': 'aGVsbG8=' } } }
      });

      const result = await service.compile({ scenarioRef: 'fraud/test@1.0.0', inputs: { amount: 100, isVip: true } });

      expect(result.initiator?.sessionStart.extensions).toEqual({ 'x.trace': 'aGVsbG8=' });
    });

    it.each([
      ['a number', 42, 'number'],
      ['an object', { a: 1 }, 'object'],
      ['null', null, 'null']
    ])(
      'rejects a non-string extensions value (%s) with COMPILATION_ERROR naming the key',
      async (_label, value, got) => {
        mockIndex.getScenarioVersion.mockResolvedValue({
          ...mockScenario,
          spec: {
            ...mockScenario.spec,
            launch: { ...mockScenario.spec.launch, extensions: { 'x.bad': value } as unknown as Record<string, string> }
          }
        });

        const err = await service
          .compile({ scenarioRef: 'fraud/test@1.0.0', inputs: { amount: 100, isVip: true } })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.COMPILATION_ERROR);
        expect((err as AppException).message).toContain('launch.extensions.x.bad');
        expect((err as AppException).message).toContain(got);
      }
    );

    it.each([
      ["a bare `extensions:` key (parses to '')", '', 'got ""'],
      ['a string', 'aGVsbG8=', 'got "aGVsbG8="'],
      ['an array', ['aGVsbG8='], 'got array']
    ])('rejects a non-mapping extensions container (%s)', async (_label, value, got) => {
      mockIndex.getScenarioVersion.mockResolvedValue({
        ...mockScenario,
        spec: {
          ...mockScenario.spec,
          launch: { ...mockScenario.spec.launch, extensions: value as unknown as Record<string, string> }
        }
      });

      const err = await service
        .compile({ scenarioRef: 'fraud/test@1.0.0', inputs: { amount: 100, isVip: true } })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).errorCode).toBe(ErrorCode.COMPILATION_ERROR);
      expect((err as AppException).message).toContain('launch.extensions must be a mapping');
      expect((err as AppException).message).toContain(got);
    });

    it('treats extensions: null as absent (the SDK accepts null) rather than a 500', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue({
        ...mockScenario,
        spec: {
          ...mockScenario.spec,
          launch: { ...mockScenario.spec.launch, extensions: null as unknown as Record<string, string> }
        }
      });

      await expect(
        service.compile({ scenarioRef: 'fraud/test@1.0.0', inputs: { amount: 100, isVip: true } })
      ).resolves.toBeDefined();
    });

    it('omits initiator.kickoff when the scenario has no kickoff template', async () => {
      const noKickoffScenario: ScenarioVersionFile = {
        ...mockScenario,
        spec: {
          ...mockScenario.spec,
          launch: { ...mockScenario.spec.launch, kickoffTemplate: undefined }
        }
      };
      mockIndex.getScenarioVersion.mockResolvedValue(noKickoffScenario);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 100, isVip: true }
      });

      expect(result.initiator?.kickoff).toBeUndefined();
    });
  });

  describe('compile - display', () => {
    it('should include display metadata', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 100, isVip: true }
      });

      expect(result.display.title).toBe('Test Scenario');
      expect(result.display.scenarioRef).toBe('fraud/test@1.0.0');
      expect(result.display.expectedDecisionKinds).toEqual(['approve', 'decline']);
    });

    it('should include templateId in display when specified', async () => {
      mockIndex.getScenarioVersion.mockResolvedValue(mockScenario);
      mockIndex.getTemplate.mockResolvedValue(mockTemplate);

      const result = await service.compile({
        scenarioRef: 'fraud/test@1.0.0',
        templateId: 'strict',
        inputs: { amount: 100, isVip: true }
      });

      expect(result.display.templateId).toBe('strict');
    });
  });
});
