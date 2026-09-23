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

function buildDescriptor(): RunDescriptor {
  return {
    mode: 'sandbox',
    runtime: { kind: 'rust' },
    session: {
      sessionId: '00000000-0000-4000-8000-000000000001',
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
        json: async () => ({ runId: 'run-1', sessionId: '00000000-0000-4000-8000-000000000001', status: 'queued' }),
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
    expect(result).toEqual({ runId: 'run-1', sessionId: '00000000-0000-4000-8000-000000000001', status: 'queued' });
  });

  it('sends no Authorization header when controlPlaneApiKey is unset', async () => {
    const calls: FetchArgs[] = [];
    global.fetch = jest.fn().mockImplementation((url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ runId: 'run-1', sessionId: 's', status: 'queued' }),
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
        json: async () => ({ runId: 'run-1', sessionId: 's', status: 'queued' }),
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
    global.fetch = fetchOk({ sessionId: 's', status: 'queued' });
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
        json: async () => ({ runId: 'run-1', sessionId: 's', status: 'queued' }),
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
});
