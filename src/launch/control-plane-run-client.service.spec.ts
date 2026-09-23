import { Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { RunDescriptor } from '../contracts/run-descriptor';
import { ControlPlaneRunClient } from './control-plane-run-client.service';

type FetchArgs = { url: string; init: RequestInit };

function stubConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    controlPlaneUrl: 'http://control-plane.local:3001',
    controlPlaneTimeoutMs: 5000,
    controlPlaneApiKey: '',
    ...overrides
  } as unknown as AppConfigService;
}

const SESSION_ID = '00000000-0000-4000-8000-000000000001';

function buildDescriptor(): RunDescriptor {
  return {
    mode: 'sandbox',
    runtime: { kind: 'rust' },
    session: {
      sessionId: SESSION_ID,
      modeName: 'macp.mode.decision.v1',
      modeVersion: '1.0.0',
      configurationVersion: 'config.default',
      ttlMs: 300000,
      participants: [{ id: 'risk-agent' }]
    }
  };
}

function fetchOk(body: unknown): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as unknown as typeof fetch;
}

function fetchFail(status: number, text: string): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text
  }) as unknown as typeof fetch;
}

function fetchThrow(err: Error): typeof fetch {
  return jest.fn().mockRejectedValue(err) as unknown as typeof fetch;
}

describe('ControlPlaneRunClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs the descriptor to <controlPlaneUrl>/runs', async () => {
    const calls: FetchArgs[] = [];
    global.fetch = jest.fn().mockImplementation((url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' }),
        text: async () => ''
      });
    }) as unknown as typeof fetch;

    const client = new ControlPlaneRunClient(stubConfig());
    const descriptor = buildDescriptor();
    const result = await client.submitRun(descriptor);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://control-plane.local:3001/runs');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual(descriptor);
    expect(result).toEqual({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' });
  });

  it('sends no Authorization header when controlPlaneApiKey is unset', async () => {
    const calls: FetchArgs[] = [];
    global.fetch = jest.fn().mockImplementation((url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' }),
        text: async () => ''
      });
    }) as unknown as typeof fetch;

    const client = new ControlPlaneRunClient(stubConfig());
    await client.submitRun(buildDescriptor());

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends Authorization: Bearer <key> when controlPlaneApiKey is set', async () => {
    const calls: FetchArgs[] = [];
    global.fetch = jest.fn().mockImplementation((url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' }),
        text: async () => ''
      });
    }) as unknown as typeof fetch;

    const client = new ControlPlaneRunClient(stubConfig({ controlPlaneApiKey: 'demo-key' }));
    await client.submitRun(buildDescriptor());

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer demo-key');
  });

  it('returns null and does not call fetch when controlPlaneUrl is unset', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const client = new ControlPlaneRunClient(stubConfig({ controlPlaneUrl: '' }));

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns null on network error', async () => {
    global.fetch = fetchThrow(new Error('ECONNREFUSED'));
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
  });

  it('returns null on HTTP error status', async () => {
    global.fetch = fetchFail(401, 'Unauthorized');
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
  });

  it('returns null on unparseable JSON response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'not json'
    }) as unknown as typeof fetch;
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
  });

  it('returns null when response is missing runId', async () => {
    global.fetch = fetchOk({ sessionId: SESSION_ID, status: 'queued' });
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
  });

  it('passes an AbortSignal derived from controlPlaneTimeoutMs', async () => {
    let capturedSignal: AbortSignal | undefined;
    global.fetch = jest.fn().mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal as AbortSignal;
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' }),
        text: async () => ''
      });
    }) as unknown as typeof fetch;

    const client = new ControlPlaneRunClient(stubConfig({ controlPlaneTimeoutMs: 1234 }));
    await client.submitRun(buildDescriptor());

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('never throws — every failure mode resolves to null', async () => {
    global.fetch = fetchThrow(new Error('boom'));
    const client = new ControlPlaneRunClient(stubConfig());

    await expect(client.submitRun(buildDescriptor())).resolves.toBeNull();
  });

  it('logs a network failure reason even when the rejection is not an Error', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockRejectedValue('some non-Error rejection') as unknown as typeof fetch;
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reason=network:unknown network error'));
    warnSpy.mockRestore();
  });

  it('returns null when the JSON response body is null', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => null,
      text: async () => 'null'
    }) as unknown as typeof fetch;
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
  });

  it('returns null when the response is missing status', async () => {
    global.fetch = fetchOk({ runId: 'run-1', sessionId: SESSION_ID });
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
  });

  it('returns null when the response sessionId does not match the request sessionId', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    global.fetch = fetchOk({ runId: 'run-1', sessionId: 'some-other-session-id', status: 'queued' });
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reason=session_id_mismatch'));
    warnSpy.mockRestore();
  });

  it('strips trailing slashes from controlPlaneUrl before appending /runs', async () => {
    const calls: FetchArgs[] = [];
    global.fetch = jest.fn().mockImplementation((url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' }),
        text: async () => ''
      });
    }) as unknown as typeof fetch;

    const client = new ControlPlaneRunClient(stubConfig({ controlPlaneUrl: 'http://control-plane.local:3001///' }));
    await client.submitRun(buildDescriptor());

    expect(calls[0].url).toBe('http://control-plane.local:3001/runs');
  });

  it('derives the AbortSignal timeout from controlPlaneTimeoutMs', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    global.fetch = fetchOk({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' });

    const client = new ControlPlaneRunClient(stubConfig({ controlPlaneTimeoutMs: 1234 }));
    await client.submitRun(buildDescriptor());

    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    timeoutSpy.mockRestore();
  });

  it('passes redirect: "error" so a redirected POST fails instead of being followed', async () => {
    const calls: FetchArgs[] = [];
    global.fetch = jest.fn().mockImplementation((url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' }),
        text: async () => ''
      });
    }) as unknown as typeof fetch;

    const client = new ControlPlaneRunClient(stubConfig());
    await client.submitRun(buildDescriptor());

    expect(calls[0].init.redirect).toBe('error');
  });

  it('never logs the configured API key on success or failure paths', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const client = new ControlPlaneRunClient(stubConfig({ controlPlaneApiKey: 'super-secret-api-key' }));

    global.fetch = fetchOk({ runId: 'run-1', sessionId: SESSION_ID, status: 'queued' });
    await client.submitRun(buildDescriptor());

    global.fetch = fetchFail(401, 'Unauthorized');
    await client.submitRun(buildDescriptor());

    global.fetch = fetchThrow(new Error('ECONNREFUSED'));
    await client.submitRun(buildDescriptor());

    const allLoggedText = [...warnSpy.mock.calls, ...logSpy.mock.calls].map((args) => String(args[0])).join('\n');
    expect(allLoggedText).not.toContain('super-secret-api-key');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('falls back to an empty body in the failure log when reading the error body itself throws', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => {
        throw new Error('stream already consumed');
      }
    }) as unknown as typeof fetch;
    const client = new ControlPlaneRunClient(stubConfig());

    const result = await client.submitRun(buildDescriptor());

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reason=http_500 body='));
    warnSpy.mockRestore();
  });

  it('sanitizes newlines out of the response body before logging it (log-injection guard)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    global.fetch = fetchFail(500, 'line one\nLOG] FORGED ENTRY\r\nline two');
    const client = new ControlPlaneRunClient(stubConfig());

    await client.submitRun(buildDescriptor());

    const loggedLines = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(loggedLines.some((line) => line.includes('line one LOG] FORGED ENTRY line two'))).toBe(true);
    expect(loggedLines.some((line) => line.includes('\n'))).toBe(false);
    expect(loggedLines.some((line) => line.includes('\r'))).toBe(false);
    warnSpy.mockRestore();
  });
});
