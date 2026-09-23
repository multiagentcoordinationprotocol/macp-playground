import { allocateCancelCallback } from './cancel-callback';

describe('allocateCancelCallback', () => {
  it('returns undefined when host is empty', () => {
    expect(allocateCancelCallback({ host: '', portBase: 5000, path: '/agent/cancel' }, 'p1', 'run-1')).toBeUndefined();
  });

  it('returns port 0 (ephemeral) when portBase is unset (0)', () => {
    const tuple = allocateCancelCallback({ host: '127.0.0.1', portBase: 0, path: '/agent/cancel' }, 'p1', 'run-1');
    expect(tuple).toEqual({ host: '127.0.0.1', port: 0, path: '/agent/cancel' });
  });

  it('returns port 0 (ephemeral) when portBase is negative', () => {
    const tuple = allocateCancelCallback({ host: '127.0.0.1', portBase: -1, path: '/agent/cancel' }, 'p1', 'run-1');
    expect(tuple?.port).toBe(0);
  });

  it('deterministically derives a port offset from (runId, participantId) when portBase is set', () => {
    const config = { host: '127.0.0.1', portBase: 9000, path: '/agent/cancel' };
    const first = allocateCancelCallback(config, 'risk-agent', 'run-1');
    const second = allocateCancelCallback(config, 'risk-agent', 'run-1');
    expect(first).toEqual(second);
    expect(first?.port).toBeGreaterThanOrEqual(9000);
    expect(first?.port).toBeLessThan(9000 + 1024);
  });

  it('derives different ports for different participants on the same run', () => {
    const config = { host: '127.0.0.1', portBase: 9000, path: '/agent/cancel' };
    const risk = allocateCancelCallback(config, 'risk-agent', 'run-1');
    const compliance = allocateCancelCallback(config, 'compliance-agent', 'run-1');
    expect(risk?.port).not.toBe(compliance?.port);
  });

  it('derives different ports for the same participant across different runs', () => {
    const config = { host: '127.0.0.1', portBase: 9000, path: '/agent/cancel' };
    const runA = allocateCancelCallback(config, 'risk-agent', 'run-a');
    const runB = allocateCancelCallback(config, 'risk-agent', 'run-b');
    expect(runA?.port).not.toBe(runB?.port);
  });
});
