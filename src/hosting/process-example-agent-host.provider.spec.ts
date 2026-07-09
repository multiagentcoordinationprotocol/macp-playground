import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { AppConfigService } from '../config/app-config.service';
import { AuthTokenMinterService } from '../auth/auth-token-minter.service';
import { ExampleAgentDefinition, ExampleAgentRunContext, ParticipantAgentBinding } from '../contracts/example-agents';
import { ProcessExampleAgentHostProvider } from './process-example-agent-host.provider';
import { HostAdapterRegistry } from './host-adapter-registry';
import { LaunchSupervisor } from './launch-supervisor';
import { ManifestValidator } from './manifest-validator';

jest.mock('node:child_process');
jest.mock('node:fs');

function buildDefinition(overrides?: Partial<ExampleAgentDefinition>): ExampleAgentDefinition {
  return {
    agentRef: 'fraud-agent',
    name: 'Fraud Agent',
    role: 'fraud',
    framework: 'langgraph',
    bootstrap: {
      strategy: 'external',
      entrypoint: 'agents/langgraph_worker/main.py',
      transportIdentity: 'agent://fraud-agent',
      mode: 'attached',
      launcher: 'python'
    },
    manifest: {
      id: 'fraud-agent',
      name: 'Fraud Agent',
      framework: 'langgraph',
      entrypoint: { type: 'python_file', value: 'agents/langgraph_worker/main.py' }
    },
    tags: ['fraud'],
    ...overrides
  };
}

function buildBinding(overrides?: Partial<ParticipantAgentBinding>): ParticipantAgentBinding {
  return {
    participantId: 'fraud-agent',
    role: 'fraud',
    agentRef: 'fraud-agent',
    ...overrides
  };
}

function buildContext(overrides?: Partial<ExampleAgentRunContext>): ExampleAgentRunContext {
  return {
    runId: 'run-1',
    sessionId: 'sess-default',
    scenarioRef: 'fraud/high-value-new-device@1.0.0',
    modeName: 'macp.mode.decision.v1',
    modeVersion: '1.0.0',
    configurationVersion: 'config.default',
    ttlMs: 300000,
    participants: ['fraud-agent', 'risk-agent'],
    ...overrides
  };
}

function createMockChild(): childProcess.ChildProcess {
  const child = new EventEmitter() as unknown as childProcess.ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.defineProperty(child, 'stdout', { value: stdout });
  Object.defineProperty(child, 'stderr', { value: stderr });
  Object.defineProperty(child, 'pid', { value: 12345 });
  (child as unknown as { kill: jest.Mock }).kill = jest.fn();
  return child;
}

describe('ProcessExampleAgentHostProvider', () => {
  let provider: ProcessExampleAgentHostProvider;
  let config: AppConfigService;
  let adapterRegistry: HostAdapterRegistry;
  let supervisor: LaunchSupervisor;
  let manifestValidator: ManifestValidator;
  let authMinter: AuthTokenMinterService;

  beforeEach(() => {
    config = {
      exampleAgentPythonPath: 'python3',
      exampleAgentNodePath: '/usr/local/bin/node',
      runtimeAddress: '',
      runtimeTls: true,
      runtimeAllowInsecure: false,
      cancelCallbackHost: '127.0.0.1',
      cancelCallbackPortBase: 0,
      cancelCallbackPath: '/agent/cancel',
      authServiceUrl: 'http://auth:3200',
      authServiceTimeoutMs: 5000,
      authTokenTtlSeconds: 3600,
      authScopeOverrides: {}
    } as unknown as AppConfigService;

    adapterRegistry = new HostAdapterRegistry();
    supervisor = new LaunchSupervisor();
    manifestValidator = new ManifestValidator(adapterRegistry);
    authMinter = new AuthTokenMinterService(config);

    provider = new ProcessExampleAgentHostProvider(config, adapterRegistry, supervisor, manifestValidator, authMinter);

    jest.clearAllMocks();

    // Every spawn mints a JWT — default to a deterministic successful mint;
    // individual tests override with mockRejectedValue / mockResolvedValue.
    jest.spyOn(authMinter, 'mintToken').mockImplementation(async (sender: string) => ({
      token: `jwt-${sender}`,
      sender,
      expiresAt: Date.now() + 3600_000,
      expiresInSeconds: 3600,
      cacheOutcome: 'miss'
    }));
  });

  describe('resolve', () => {
    it('returns metadata with status resolved and processAttached false', async () => {
      const result = await provider.resolve(buildDefinition(), buildBinding());

      expect(result.status).toBe('resolved');
      expect(result.participantMetadata?.processAttached).toBe(false);
      expect(result.participantMetadata?.hostMode).toBe('external-process');
      expect(result.transportIdentity).toBe('agent://fraud-agent');
      expect(result.framework).toBe('langgraph');
    });

    it('infers python launcher from .py extension when launcher is not set', async () => {
      const definition = buildDefinition({
        bootstrap: {
          ...buildDefinition().bootstrap,
          launcher: undefined
        }
      });

      const result = await provider.resolve(definition, buildBinding());

      expect(result.participantMetadata?.launcher).toBe('python');
    });

    it('infers node launcher for non-.py entrypoints', async () => {
      const definition = buildDefinition({
        bootstrap: {
          ...buildDefinition().bootstrap,
          launcher: undefined,
          entrypoint: 'src/example-agents/runtime/risk-decider.worker.ts'
        }
      });

      const result = await provider.resolve(definition, buildBinding());

      expect(result.participantMetadata?.launcher).toBe('node');
    });

    it('reports adapter availability in metadata', async () => {
      const result = await provider.resolve(buildDefinition(), buildBinding());

      expect(result.participantMetadata?.adapterAvailable).toBe(true);
    });
  });

  describe('attach', () => {
    it('returns bootstrapped without spawning when mode is not attached', async () => {
      const definition = buildDefinition({
        bootstrap: {
          ...buildDefinition().bootstrap,
          mode: 'deferred'
        }
      });

      const result = await provider.attach(definition, buildBinding(), buildContext());

      expect(result.status).toBe('bootstrapped');
      expect(result.participantMetadata?.processAttached).toBe(false);
      expect(result.participantMetadata?.attachmentMode).toBe('deferred');
    });

    it('spawns a python process for attached mode via the adapter', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const mockChild = createMockChild();
      jest.spyOn(supervisor, 'writeBootstrapFile').mockReturnValue('/tmp/bootstrap.json');
      jest.spyOn(supervisor, 'launch').mockReturnValue({
        handle: { participantId: 'fraud-agent', runId: 'run-1', pid: 12345, framework: 'langgraph' },
        child: mockChild,
        manifest: {
          id: 'fraud-agent',
          name: 'Fraud Agent',
          framework: 'langgraph',
          entrypoint: { type: 'python_file', value: 'test.py' }
        },
        launchedAt: '2026-01-01T00:00:00Z',
        command: 'python3',
        args: ['test.py'],
        bootstrapFilePath: '/tmp/bootstrap.json',
        healthStatus: 'starting'
      });

      const result = await provider.attach(buildDefinition(), buildBinding(), buildContext());

      expect(supervisor.writeBootstrapFile).toHaveBeenCalled();
      expect(supervisor.launch).toHaveBeenCalled();
      expect(result.status).toBe('bootstrapped');
      expect(result.participantMetadata?.processAttached).toBe(true);
      expect(result.participantMetadata?.pid).toBe(12345);
      expect(result.participantMetadata?.launchMode).toBe('adapter');
    });

    it('deduplicates by runId:participantId via supervisor', async () => {
      const mockChild = createMockChild();
      jest.spyOn(supervisor, 'getProcess').mockReturnValue({
        handle: { participantId: 'fraud-agent', runId: 'run-1', pid: 12345, framework: 'langgraph' },
        child: mockChild,
        manifest: {
          id: 'fraud-agent',
          name: 'Fraud Agent',
          framework: 'langgraph',
          entrypoint: { type: 'python_file', value: 'test.py' }
        },
        launchedAt: '2026-01-01T00:00:00Z',
        command: 'python3',
        args: ['test.py'],
        bootstrapFilePath: '/tmp/bootstrap.json',
        healthStatus: 'healthy'
      });

      const result = await provider.attach(buildDefinition(), buildBinding(), buildContext());

      expect(result.status).toBe('bootstrapped');
      expect(result.participantMetadata?.processAttached).toBe(true);
      expect(result.participantMetadata?.pid).toBe(12345);
    });
  });

  describe('onModuleDestroy', () => {
    it('delegates cleanup to supervisor', () => {
      const spy = jest.spyOn(supervisor, 'onModuleDestroy');
      provider.onModuleDestroy();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('direct-agent-auth bootstrap payload', () => {
    it('populates runtime.address + minted bearerToken + sessionId', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const mockChild = createMockChild();
      (config as unknown as { runtimeAddress: string }).runtimeAddress = 'runtime.local:50051';

      const writeSpy = jest.spyOn(supervisor, 'writeBootstrapFile').mockReturnValue('/tmp/bootstrap.json');
      jest.spyOn(supervisor, 'launch').mockReturnValue({
        handle: { participantId: 'fraud-agent', runId: 'run-1', pid: 12345, framework: 'langgraph' },
        child: mockChild,
        manifest: {
          id: 'fraud-agent',
          name: 'Fraud Agent',
          framework: 'langgraph',
          entrypoint: { type: 'python_file', value: 'test.py' }
        },
        launchedAt: '2026-01-01T00:00:00Z',
        command: 'python3',
        args: ['test.py'],
        bootstrapFilePath: '/tmp/bootstrap.json',
        healthStatus: 'starting'
      });

      const ctx = buildContext({ sessionId: 'sess-uuid-v4', initiator: undefined });
      await provider.attach(buildDefinition(), buildBinding(), ctx);

      const bootstrap = writeSpy.mock.calls[0][0];
      expect(bootstrap.session_id).toBe('sess-uuid-v4');
      expect(bootstrap.runtime_url).toBe('runtime.local:50051');
      expect(bootstrap.auth_token).toBe('jwt-fraud-agent');
      expect(bootstrap.secure).toBe(true);
      expect(bootstrap.cancel_callback?.host).toBe('127.0.0.1');
      expect(bootstrap.cancel_callback?.path).toBe('/agent/cancel');
    });

    it('populates initiator.sessionStart + kickoff only on the initiator agent', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const mockChild = createMockChild();

      const writeSpy = jest.spyOn(supervisor, 'writeBootstrapFile').mockReturnValue('/tmp/bootstrap.json');
      jest.spyOn(supervisor, 'launch').mockReturnValue({
        handle: { participantId: 'fraud-agent', runId: 'run-1', pid: 12345, framework: 'langgraph' },
        child: mockChild,
        manifest: {
          id: 'fraud-agent',
          name: 'Fraud Agent',
          framework: 'langgraph',
          entrypoint: { type: 'python_file', value: 'test.py' }
        },
        launchedAt: '2026-01-01T00:00:00Z',
        command: 'python3',
        args: ['test.py'],
        bootstrapFilePath: '/tmp/bootstrap.json',
        healthStatus: 'starting'
      });

      const ctx = buildContext({
        sessionId: 'sess-uuid-v4',
        initiator: {
          participantId: 'fraud-agent',
          sessionStart: {
            intent: 'fraud/high-value-new-device',
            participants: ['fraud-agent', 'risk-agent'],
            ttlMs: 300000,
            modeVersion: '1.0.0',
            configurationVersion: 'config.default'
          },
          kickoff: { messageType: 'Proposal', payload: { option: 'review' } }
        }
      });

      await provider.attach(buildDefinition(), buildBinding({ participantId: 'fraud-agent' }), ctx);
      let bootstrap = writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0];
      expect(bootstrap.initiator).toBeDefined();
      expect(bootstrap.initiator?.session_start.intent).toBe('fraud/high-value-new-device');
      expect(bootstrap.initiator?.kickoff?.message_type).toBe('Proposal');

      await provider.attach(
        buildDefinition({ agentRef: 'risk-agent', name: 'Risk Agent', framework: 'custom' }),
        buildBinding({ participantId: 'risk-agent', agentRef: 'risk-agent' }),
        ctx
      );
      bootstrap = writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0];
      expect(bootstrap.initiator).toBeUndefined();
    });
  });

  describe('JWT minting (AUTH-2)', () => {
    it('writes the minted JWT into the bootstrap', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const mintSpy = jest.spyOn(authMinter, 'mintToken').mockResolvedValue({
        token: 'jwt-minted-fraud',
        sender: 'fraud-agent',
        expiresAt: Date.now() + 3600_000,
        expiresInSeconds: 3600,
        cacheOutcome: 'miss'
      });

      const writeSpy = jest.spyOn(supervisor, 'writeBootstrapFile').mockReturnValue('/tmp/bootstrap.json');
      const mockChild = createMockChild();
      jest.spyOn(supervisor, 'launch').mockReturnValue({
        handle: { participantId: 'fraud-agent', runId: 'run-1', pid: 111, framework: 'langgraph' },
        child: mockChild,
        manifest: { id: 'x', name: 'x', framework: 'langgraph', entrypoint: { type: 'python_file', value: 'x.py' } },
        launchedAt: 'now',
        command: 'python3',
        args: [],
        bootstrapFilePath: '/tmp/bootstrap.json',
        healthStatus: 'starting'
      });

      const ctx = buildContext({
        sessionId: 'sess-1',
        initiator: {
          participantId: 'fraud-agent',
          sessionStart: {
            intent: 'fraud/x',
            participants: ['fraud-agent', 'risk-agent'],
            ttlMs: 300000,
            modeVersion: '1.0.0',
            configurationVersion: 'config.default'
          }
        }
      });

      await provider.attach(buildDefinition(), buildBinding(), ctx);

      expect(mintSpy).toHaveBeenCalledTimes(1);
      expect(mintSpy).toHaveBeenCalledWith('fraud-agent', {
        can_start_sessions: true,
        is_observer: false,
        allowed_modes: ['macp.mode.decision.v1', '']
      });
      const bootstrap = writeSpy.mock.calls[0][0];
      expect(bootstrap.auth_token).toBe('jwt-minted-fraud');
    });

    it('non-initiator mints with can_start_sessions=false', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const mintSpy = jest.spyOn(authMinter, 'mintToken').mockResolvedValue({
        token: 'jwt-risk',
        sender: 'risk-agent',
        expiresAt: Date.now() + 3600_000,
        expiresInSeconds: 3600,
        cacheOutcome: 'miss'
      });

      jest.spyOn(supervisor, 'writeBootstrapFile').mockReturnValue('/tmp/bootstrap.json');
      const mockChild = createMockChild();
      jest.spyOn(supervisor, 'launch').mockReturnValue({
        handle: { participantId: 'risk-agent', runId: 'run-1', pid: 222, framework: 'custom' },
        child: mockChild,
        manifest: { id: 'x', name: 'x', framework: 'custom', entrypoint: { type: 'node_file', value: 'x.js' } },
        launchedAt: 'now',
        command: 'node',
        args: [],
        bootstrapFilePath: '/tmp/bootstrap.json',
        healthStatus: 'starting'
      });

      const ctx = buildContext({
        sessionId: 'sess-1',
        initiator: {
          participantId: 'fraud-agent',
          sessionStart: {
            intent: 'fraud/x',
            participants: ['fraud-agent', 'risk-agent'],
            ttlMs: 300000,
            modeVersion: '1.0.0',
            configurationVersion: 'config.default'
          }
        }
      });

      await provider.attach(
        buildDefinition({ agentRef: 'risk-agent', framework: 'custom' }),
        buildBinding({ participantId: 'risk-agent', agentRef: 'risk-agent' }),
        ctx
      );

      expect(mintSpy).toHaveBeenCalledWith('risk-agent', {
        can_start_sessions: false,
        is_observer: false,
        allowed_modes: ['macp.mode.decision.v1', '']
      });
    });

    it('merges per-sender scope overrides from MACP_AUTH_SCOPES_JSON', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (config as unknown as { authScopeOverrides: Record<string, unknown> }).authScopeOverrides = {
        'fraud-agent': { is_observer: true, max_open_sessions: 2 }
      };

      const mintSpy = jest.spyOn(authMinter, 'mintToken').mockResolvedValue({
        token: 'jwt-ovr',
        sender: 'fraud-agent',
        expiresAt: Date.now() + 3600_000,
        expiresInSeconds: 3600,
        cacheOutcome: 'miss'
      });

      jest.spyOn(supervisor, 'writeBootstrapFile').mockReturnValue('/tmp/bootstrap.json');
      const mockChild = createMockChild();
      jest.spyOn(supervisor, 'launch').mockReturnValue({
        handle: { participantId: 'fraud-agent', runId: 'run-1', pid: 1, framework: 'langgraph' },
        child: mockChild,
        manifest: { id: 'x', name: 'x', framework: 'langgraph', entrypoint: { type: 'python_file', value: 'x.py' } },
        launchedAt: 'now',
        command: 'python3',
        args: [],
        bootstrapFilePath: '/tmp/bootstrap.json',
        healthStatus: 'starting'
      });

      await provider.attach(buildDefinition(), buildBinding(), buildContext({ sessionId: 'sess-1' }));

      expect(mintSpy).toHaveBeenCalledWith('fraud-agent', {
        can_start_sessions: false,
        is_observer: true,
        allowed_modes: ['macp.mode.decision.v1', ''],
        max_open_sessions: 2
      });
    });

    it('propagates mint failure as AUTH_MINT_FAILED without fallback', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      jest
        .spyOn(authMinter, 'mintToken')
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- test-local import
        .mockRejectedValue(new (require('../errors/app-exception').AppException)('AUTH_MINT_FAILED', 'down', 502));

      jest.spyOn(supervisor, 'writeBootstrapFile').mockReturnValue('/tmp/bootstrap.json');

      await expect(
        provider.attach(buildDefinition(), buildBinding(), buildContext({ sessionId: 'sess-1' }))
      ).rejects.toMatchObject({ errorCode: 'AUTH_MINT_FAILED' });
    });

    it('MACP_RUNTIME_TOKEN env var mirrors the bootstrap auth_token', async () => {
      // This is the `docs/onboarding-an-agent.md` public contract for custom
      // user agents. Verified by reading the env passed into supervisor.launch.
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      jest.spyOn(authMinter, 'mintToken').mockResolvedValue({
        token: 'jwt-env-mirror',
        sender: 'fraud-agent',
        expiresAt: Date.now() + 3600_000,
        expiresInSeconds: 3600,
        cacheOutcome: 'miss'
      });

      const launchSpy = jest.spyOn(supervisor, 'launch').mockReturnValue({
        handle: { participantId: 'fraud-agent', runId: 'run-1', pid: 4, framework: 'langgraph' },
        child: createMockChild(),
        manifest: { id: 'x', name: 'x', framework: 'langgraph', entrypoint: { type: 'python_file', value: 'x.py' } },
        launchedAt: 'now',
        command: 'python3',
        args: [],
        bootstrapFilePath: '/tmp/bootstrap.json',
        healthStatus: 'starting'
      });
      jest.spyOn(supervisor, 'writeBootstrapFile').mockReturnValue('/tmp/bootstrap.json');

      await provider.attach(buildDefinition(), buildBinding(), buildContext({ sessionId: 'sess-1' }));

      const prepared = launchSpy.mock.calls[0][0] as { env: Record<string, string> };
      expect(prepared.env.MACP_RUNTIME_TOKEN).toBe('jwt-env-mirror');
    });
  });
});
