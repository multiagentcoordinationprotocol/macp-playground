import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { LaunchSupervisor } from './launch-supervisor';
import { AgentManifest } from './contracts/manifest.types';
import { BootstrapPayload } from './contracts/bootstrap.types';
import { PreparedLaunch } from './contracts/host-adapter.types';

jest.mock('node:child_process');
jest.mock('node:fs');

function createMockChild(pid = 12345): childProcess.ChildProcess {
  const child = new EventEmitter() as unknown as childProcess.ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.defineProperty(child, 'stdout', { value: stdout });
  Object.defineProperty(child, 'stderr', { value: stderr });
  Object.defineProperty(child, 'pid', { value: pid });
  (child as unknown as { kill: jest.Mock }).kill = jest.fn();
  return child;
}

function buildManifest(): AgentManifest {
  return {
    id: 'fraud-agent',
    name: 'Fraud Agent',
    framework: 'langgraph',
    entrypoint: { type: 'python_file', value: 'agents/test.py' }
  };
}

function buildBootstrap(): BootstrapPayload {
  return {
    participant_id: 'fraud-agent',
    session_id: 'sess-uuid-v4',
    mode: 'macp.mode.decision.v1',
    runtime_url: '',
    auth_token: 'jwt-test',
    participants: ['fraud-agent', 'risk-agent'],
    mode_version: '1.0.0',
    configuration_version: 'config.default',
    metadata: {
      run_id: 'run-1',
      trace_id: 'trace-1',
      scenario_ref: 'fraud/test@1.0.0',
      role: 'fraud',
      framework: 'langgraph',
      agent_ref: 'fraud-agent'
    }
  };
}

function buildPrepared(): PreparedLaunch {
  return {
    command: 'python3',
    args: ['agents/test.py'],
    env: { PATH: '/usr/bin' },
    cwd: '/app',
    startupTimeoutMs: 5000
  };
}

describe('LaunchSupervisor', () => {
  let supervisor: LaunchSupervisor;

  beforeEach(() => {
    jest.useFakeTimers();
    supervisor = new LaunchSupervisor();
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.mkdirSync as jest.Mock).mockReturnValue(undefined);
    (fs.writeFileSync as jest.Mock).mockReturnValue(undefined);
    (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);
  });

  afterEach(() => {
    supervisor.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('writeBootstrapFile', () => {
    it('writes a JSON file and returns the path', () => {
      const filePath = supervisor.writeBootstrapFile(buildBootstrap());
      expect(filePath).toContain('run-1_fraud-agent_');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('launch', () => {
    it('spawns a process and returns a supervised record', () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);

      const record = supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'python3',
        ['agents/test.py'],
        expect.objectContaining({
          cwd: '/app',
          env: expect.objectContaining({ MACP_BOOTSTRAP_FILE: '/tmp/bootstrap.json' })
        })
      );
      expect(record.handle.participantId).toBe('fraud-agent');
      expect(record.handle.runId).toBe('run-1');
      expect(record.handle.pid).toBe(12345);
      expect(record.healthStatus).toBe('starting');
    });

    it('deduplicates by runId:participantId', () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);

      supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');
      const second = supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap2.json');

      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
      expect(second.handle.pid).toBe(12345);
    });
  });

  describe('confirmSpawn', () => {
    it('resolves ok:true when the process outlives the confirmation window', async () => {
      (childProcess.spawn as jest.Mock).mockReturnValue(createMockChild());
      const record = supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');

      const confirmation = supervisor.confirmSpawn(record, 400);
      jest.advanceTimersByTime(400);

      await expect(confirmation).resolves.toEqual({ ok: true });
    });

    it('resolves ok:false when spawn() fails asynchronously (e.g. ENOENT)', async () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);
      const record = supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');

      const confirmation = supervisor.confirmSpawn(record, 400);
      mockChild.emit('error', new Error('spawn python3 ENOENT'));

      await expect(confirmation).resolves.toEqual({
        ok: false,
        error: 'spawn error: spawn python3 ENOENT'
      });
    });

    it('resolves ok:false when the process exits before the window elapses', async () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);
      const record = supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');

      const confirmation = supervisor.confirmSpawn(record, 400);
      mockChild.emit('exit', 1, null);

      await expect(confirmation).resolves.toEqual({
        ok: false,
        error: 'process exited before attach confirmed (code=1, signal=null)'
      });
    });

    it('resolves ok:false immediately for a record already known unhealthy/stopped', async () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);
      const record = supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');
      record.healthStatus = 'unhealthy';

      const confirmation = await supervisor.confirmSpawn(record, 400);

      expect(confirmation.ok).toBe(false);
    });

    it('does not fire after resolving once the window elapses (no dangling listeners)', async () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);
      const record = supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');

      const confirmation = supervisor.confirmSpawn(record, 400);
      jest.advanceTimersByTime(400);
      await expect(confirmation).resolves.toEqual({ ok: true });

      // An exit after confirmation already resolved must not throw or hang —
      // the listeners were removed once `finish()` ran.
      expect(() => mockChild.emit('exit', 1, null)).not.toThrow();
    });
  });

  describe('getProcess', () => {
    it('returns undefined for unknown process', () => {
      expect(supervisor.getProcess('run-1', 'unknown')).toBeUndefined();
    });

    it('returns process after launch', () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);

      supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');
      const process = supervisor.getProcess('run-1', 'fraud-agent');

      expect(process).toBeDefined();
      expect(process?.handle.participantId).toBe('fraud-agent');
    });
  });

  describe('getProcessesForRun', () => {
    it('returns all processes for a given runId', () => {
      (childProcess.spawn as jest.Mock).mockReturnValue(createMockChild());

      supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/b1.json');

      const bootstrap2 = buildBootstrap();
      bootstrap2.participant_id = 'growth-agent';
      supervisor.launch(buildPrepared(), buildManifest(), bootstrap2, '/tmp/b2.json');

      const processes = supervisor.getProcessesForRun('run-1');
      expect(processes).toHaveLength(2);
    });
  });

  describe('health', () => {
    it('returns unknown for non-existent process', () => {
      expect(supervisor.health('run-1', 'unknown')).toBe('unknown');
    });

    it('returns starting for freshly launched process', () => {
      (childProcess.spawn as jest.Mock).mockReturnValue(createMockChild());
      supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');
      expect(supervisor.health('run-1', 'fraud-agent')).toBe('starting');
    });
  });

  describe('stop', () => {
    it('sends SIGTERM and cleans up', async () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);

      supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');
      jest.advanceTimersByTime(10000);

      jest.useRealTimers();
      const stopPromise = supervisor.stop('run-1', 'fraud-agent');
      mockChild.emit('exit', 0, null);
      await stopPromise;

      expect((mockChild as unknown as { kill: jest.Mock }).kill).toHaveBeenCalledWith('SIGTERM');
      expect(supervisor.getProcess('run-1', 'fraud-agent')).toBeUndefined();
      jest.useFakeTimers();
    });
  });

  describe('onModuleDestroy', () => {
    it('terminates all tracked processes', () => {
      const mockChild = createMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValue(mockChild);

      supervisor.launch(buildPrepared(), buildManifest(), buildBootstrap(), '/tmp/bootstrap.json');
      supervisor.onModuleDestroy();

      expect((mockChild as unknown as { kill: jest.Mock }).kill).toHaveBeenCalledWith('SIGTERM');
    });
  });
});
