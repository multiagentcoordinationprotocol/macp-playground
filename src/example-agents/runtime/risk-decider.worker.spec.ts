import { BootstrapPayload } from '../../hosting/contracts/bootstrap.types';

// ── SDK mocks ────────────────────────────────────────────────────────
const mockRun = jest.fn().mockResolvedValue(undefined);
const mockStop = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();
const mockOnTerminal = jest.fn();
const mockActions = {
  vote: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  evaluate: jest.fn().mockResolvedValue(undefined)
};
// participant.client surface the worker reaches into directly (session.context
// signal emission + cancel-on-policy-denial).
const mockCancelSession = jest.fn().mockResolvedValue({ ok: true });
const mockClientSend = jest.fn().mockResolvedValue(undefined);
const mockAuth = { kind: 'bearer', token: 'tok-risk' };

jest.mock('macp-sdk-typescript', () => ({
  agent: {
    fromBootstrap: jest.fn(() => ({
      run: mockRun,
      stop: mockStop,
      on: mockOn,
      onTerminal: mockOnTerminal,
      actions: mockActions,
      auth: mockAuth,
      client: {
        cancelSession: mockCancelSession,
        send: mockClientSend,
        protoRegistry: { encodeKnownPayload: jest.fn(() => ({})) }
      }
    }))
  },
  buildEnvelope: jest.fn(() => ({})),
  buildSignalPayload: jest.fn(() => ({}))
}));

// ── worker-side mocks ────────────────────────────────────────────────
const mockLoadBootstrap = jest.fn();

jest.mock('./bootstrap-loader', () => ({
  loadBootstrapPayload: () => mockLoadBootstrap(),
  hasDirectRuntimeIdentity: (b: BootstrapPayload) => Boolean(b.runtime_url && b.auth_token),
  isInitiator: (b: BootstrapPayload) => Boolean(b.initiator)
}));

// ── helpers ─────────────────────────────────────────────────────────
function defaultBootstrap(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    participant_id: 'risk-coordinator',
    agent_id: 'risk-agent',
    session_id: 'sess-uuid-v4',
    mode: 'macp.mode.decision.v1',
    runtime_url: 'runtime.local:50051',
    auth_token: 'tok-risk',
    secure: true,
    allow_insecure: false,
    participants: ['risk-coordinator', 'fraud-agent', 'compliance-agent'],
    mode_version: '1.0.0',
    configuration_version: 'config.default',
    policy_version: 'policy.fraud.majority-veto',
    cancel_callback: { host: '127.0.0.1', port: 0, path: '/agent/cancel' },
    metadata: {
      run_id: 'run-1',
      trace_id: 'trace-1',
      scenario_ref: 'fraud/high-value-new-device@1.0.0',
      role: 'coordinator',
      framework: 'custom',
      agent_ref: 'risk-agent',
      policy_hints: { type: 'majority', threshold: 0.5, vetoEnabled: false },
      session_context: { transactionAmount: 5000 }
    },
    ...overrides
  };
}

async function runWorker(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    jest.isolateModules(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./risk-decider.worker');
      } catch (e) {
        reject(e);
      }
    });
    setTimeout(resolve, 200);
  });
}

// Pull a registered handler back off the `participant.on(type, fn)` mock so the
// test can drive the Proposal → Evaluation → commit flow directly.
function getHandler(type: string): (message: unknown, ctx?: unknown) => void {
  const call = mockOn.mock.calls.find((c: unknown[]) => c[0] === type);
  if (!call) throw new Error(`no handler registered for ${type}`);
  return call[1] as (message: unknown, ctx?: unknown) => void;
}

// Drive both specialists to APPROVE so the coordinator reaches quorum and
// attempts a commit through the supplied ctx. `commitImpl` decides whether the
// runtime accepts (resolves) or rejects (throws) that commit.
async function driveToCommit(commitImpl: jest.Mock): Promise<{ commit: jest.Mock; vote: jest.Mock }> {
  const ctx = {
    actions: {
      vote: jest.fn().mockResolvedValue(undefined),
      commit: commitImpl
    }
  };
  const onProposal = getHandler('Proposal');
  const onEvaluation = getHandler('Evaluation');

  onProposal({ proposalId: 'p1', sender: 'fraud-agent', payload: {} });
  onEvaluation({ proposalId: 'p1', sender: 'fraud-agent', payload: { recommendation: 'APPROVE', confidence: 1 } }, ctx);
  onEvaluation(
    { proposalId: 'p1', sender: 'compliance-agent', payload: { recommendation: 'APPROVE', confidence: 1 } },
    ctx
  );

  await jest.advanceTimersByTimeAsync(50);
  return { commit: ctx.actions.commit, vote: ctx.actions.vote };
}

// ── tests ───────────────────────────────────────────────────────────
describe('risk-decider.worker (SDK Participant)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers Proposal, Evaluation, and Objection handlers', async () => {
    mockLoadBootstrap.mockReturnValue(defaultBootstrap());

    await runWorker();
    await jest.advanceTimersByTimeAsync(500);

    const registeredTypes = mockOn.mock.calls.map((call: unknown[]) => call[0]);
    expect(registeredTypes).toContain('Proposal');
    expect(registeredTypes).toContain('Evaluation');
    expect(registeredTypes).toContain('Objection');
  });

  it('registers a terminal handler', async () => {
    mockLoadBootstrap.mockReturnValue(defaultBootstrap());

    await runWorker();
    await jest.advanceTimersByTimeAsync(500);

    expect(mockOnTerminal).toHaveBeenCalled();
  });

  it('calls participant.run()', async () => {
    mockLoadBootstrap.mockReturnValue(defaultBootstrap());

    await runWorker();
    await jest.advanceTimersByTimeAsync(500);

    expect(mockRun).toHaveBeenCalled();
  });

  it('sets process.exitCode = 1 on unhandled error', async () => {
    mockLoadBootstrap.mockImplementation(() => {
      throw new Error('bootstrap missing');
    });

    const originalExitCode = process.exitCode;
    await runWorker();
    await jest.advanceTimersByTimeAsync(500);

    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });

  it('cancels the session to a terminal CANCELLED state when the runtime rejects the commit', async () => {
    mockLoadBootstrap.mockReturnValue(defaultBootstrap());
    await runWorker();
    await jest.advanceTimersByTimeAsync(10);

    const { commit } = await driveToCommit(
      jest.fn().mockRejectedValue(new Error('POLICY_DENIED: PolicyDenied'))
    );

    // The commit was attempted and rejected by the runtime policy engine...
    expect(commit).toHaveBeenCalled();
    // ...so the coordinator drives the session terminal via cancelSession
    // (proto 0.1.3 / macp-sdk-typescript 0.4.0) rather than leaving it to TTL.
    expect(mockCancelSession).toHaveBeenCalledTimes(1);
    expect(mockCancelSession).toHaveBeenCalledWith(
      'sess-uuid-v4',
      expect.stringContaining('POLICY_DENIED'),
      expect.objectContaining({ auth: mockAuth, cancelledBy: 'risk-coordinator' })
    );
  });

  it('does not cancel the session when the commit is accepted', async () => {
    mockLoadBootstrap.mockReturnValue(defaultBootstrap());
    await runWorker();
    await jest.advanceTimersByTimeAsync(10);

    const { commit } = await driveToCommit(jest.fn().mockResolvedValue(undefined));

    expect(commit).toHaveBeenCalled();
    expect(mockCancelSession).not.toHaveBeenCalled();
  });
});
