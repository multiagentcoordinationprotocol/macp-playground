import { AuthTokenMinterService } from './auth-token-minter.service';
import { AppConfigService, MacpScopes } from '../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

type FetchArgs = { url: string; init: RequestInit };

function stubConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    authServiceUrl: 'http://auth-service.local:3200',
    authServiceTimeoutMs: 5000,
    authTokenTtlSeconds: 3600,
    ...overrides
  } as unknown as AppConfigService;
}

function fetchOk(body: unknown): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
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

describe('AuthTokenMinterService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  describe('mintToken happy path', () => {
    it('POSTs to /tokens with sender, TTL, and scopes', async () => {
      const calls: FetchArgs[] = [];
      global.fetch = jest.fn().mockImplementation((url, init) => {
        calls.push({ url: url as string, init: init as RequestInit });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ token: 'jwt-aaa', sender: 'risk-agent', expires_in_seconds: 900 }),
          text: async () => ''
        });
      }) as unknown as typeof fetch;

      const minter = new AuthTokenMinterService(stubConfig({ authTokenTtlSeconds: 900 }));
      const result = await minter.mintToken('risk-agent', {
        can_start_sessions: true,
        allowed_modes: ['macp.mode.decision.v1']
      });

      expect(result.token).toBe('jwt-aaa');
      expect(result.sender).toBe('risk-agent');
      expect(result.expiresInSeconds).toBe(900);
      expect(result.cacheOutcome).toBe('miss');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://auth-service.local:3200/tokens');
      expect(calls[0].init.method).toBe('POST');
      const body = JSON.parse(calls[0].init.body as string);
      expect(body).toEqual({
        sender: 'risk-agent',
        ttl_seconds: 900,
        scopes: { can_start_sessions: true, allowed_modes: ['macp.mode.decision.v1'] }
      });
    });

    it('omits scopes key when no scopes are passed', async () => {
      const calls: FetchArgs[] = [];
      global.fetch = jest.fn().mockImplementation((url, init) => {
        calls.push({ url: url as string, init: init as RequestInit });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ token: 'jwt', sender: 'a', expires_in_seconds: 60 }),
          text: async () => ''
        });
      }) as unknown as typeof fetch;

      const minter = new AuthTokenMinterService(stubConfig());
      await minter.mintToken('a');

      const body = JSON.parse(calls[0].init.body as string);
      expect(body).toEqual({ sender: 'a', ttl_seconds: 3600 });
    });
  });

  describe('cache behavior', () => {
    it('returns a cache hit on repeat mint within TTL', async () => {
      const fetcher = fetchOk({ token: 'jwt-one', sender: 'risk', expires_in_seconds: 300 });
      global.fetch = fetcher;
      const minter = new AuthTokenMinterService(stubConfig());

      const first = await minter.mintToken('risk');
      const second = await minter.mintToken('risk');

      expect(first.cacheOutcome).toBe('miss');
      expect(second.cacheOutcome).toBe('hit');
      expect(second.token).toBe('jwt-one');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('re-mints after cache expiry', async () => {
      const fetcher = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ token: 'jwt-a', sender: 's', expires_in_seconds: 1 }),
          text: async () => ''
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ token: 'jwt-b', sender: 's', expires_in_seconds: 300 }),
          text: async () => ''
        });
      global.fetch = fetcher as unknown as typeof fetch;

      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const minter = new AuthTokenMinterService(stubConfig());

      const first = await minter.mintToken('s');
      expect(first.token).toBe('jwt-a');
      expect(first.cacheOutcome).toBe('miss');

      // advance past the 1s TTL (minus 10s skew means cache is invalid immediately)
      jest.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      const second = await minter.mintToken('s');
      expect(second.token).toBe('jwt-b');
      expect(second.cacheOutcome).toBe('miss');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('cache keys differ by scope shape', async () => {
      const fetcher = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ token: 'jwt-a', sender: 's', expires_in_seconds: 300 }),
          text: async () => ''
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ token: 'jwt-b', sender: 's', expires_in_seconds: 300 }),
          text: async () => ''
        });
      global.fetch = fetcher as unknown as typeof fetch;

      const minter = new AuthTokenMinterService(stubConfig());
      const scopesA: MacpScopes = { can_start_sessions: true };
      const scopesB: MacpScopes = { can_start_sessions: false };

      const a = await minter.mintToken('s', scopesA);
      const b = await minter.mintToken('s', scopesB);

      expect(a.token).toBe('jwt-a');
      expect(b.token).toBe('jwt-b');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('single-flight', () => {
    it('collapses concurrent mint calls for same key into one HTTP request', async () => {
      let resolveFetch: (value: unknown) => void = () => undefined;
      const fetchCount = { calls: 0 };
      global.fetch = jest.fn().mockImplementation(() => {
        fetchCount.calls += 1;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      }) as unknown as typeof fetch;

      const minter = new AuthTokenMinterService(stubConfig());
      const p1 = minter.mintToken('s');
      const p2 = minter.mintToken('s');
      const p3 = minter.mintToken('s');

      expect(fetchCount.calls).toBe(1);

      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({ token: 'jwt-x', sender: 's', expires_in_seconds: 300 }),
        text: async () => ''
      });

      const [a, b, c] = await Promise.all([p1, p2, p3]);
      expect(a.token).toBe('jwt-x');
      expect(b.token).toBe('jwt-x');
      expect(c.token).toBe('jwt-x');
      expect(fetchCount.calls).toBe(1);
    });
  });

  describe('failure modes', () => {
    it('throws AUTH_MINT_FAILED on network error', async () => {
      global.fetch = fetchThrow(new Error('ECONNREFUSED'));
      const minter = new AuthTokenMinterService(stubConfig());
      try {
        await minter.mintToken('s');
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.AUTH_MINT_FAILED);
        expect((err as AppException).getStatus()).toBe(502);
      }
    });

    it('throws AUTH_MINT_FAILED on HTTP 5xx', async () => {
      global.fetch = fetchFail(500, 'boom');
      const minter = new AuthTokenMinterService(stubConfig());
      try {
        await minter.mintToken('s');
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.AUTH_MINT_FAILED);
      }
    });

    it('throws AUTH_MINT_FAILED on HTTP 4xx', async () => {
      global.fetch = fetchFail(400, 'bad sender');
      const minter = new AuthTokenMinterService(stubConfig());
      await expect(minter.mintToken('s')).rejects.toBeInstanceOf(AppException);
    });

    it('throws AUTH_MINT_FAILED when response has no token', async () => {
      global.fetch = fetchOk({ sender: 's', expires_in_seconds: 60 });
      const minter = new AuthTokenMinterService(stubConfig());
      await expect(minter.mintToken('s')).rejects.toBeInstanceOf(AppException);
    });

    it('throws AUTH_MINT_FAILED when sender is empty', async () => {
      const minter = new AuthTokenMinterService(stubConfig());
      await expect(minter.mintToken('')).rejects.toBeInstanceOf(AppException);
    });

    it('throws AUTH_MINT_FAILED when authServiceUrl is empty', async () => {
      global.fetch = fetchOk({ token: 'jwt', sender: 's', expires_in_seconds: 60 });
      const minter = new AuthTokenMinterService(stubConfig({ authServiceUrl: '' }));
      await expect(minter.mintToken('s')).rejects.toBeInstanceOf(AppException);
    });

    it('inflight promise is cleared on failure so next call can succeed', async () => {
      const calls: unknown[] = [];
      const fetcher = jest
        .fn()
        .mockImplementationOnce(() => Promise.reject(new Error('first failed')))
        .mockImplementationOnce(() => {
          calls.push('ok');
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ token: 'jwt-ok', sender: 's', expires_in_seconds: 300 }),
            text: async () => ''
          });
        });
      global.fetch = fetcher as unknown as typeof fetch;

      const minter = new AuthTokenMinterService(stubConfig());
      await expect(minter.mintToken('s')).rejects.toBeInstanceOf(AppException);
      const second = await minter.mintToken('s');
      expect(second.token).toBe('jwt-ok');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('mergeScopes', () => {
    it('override replaces base values', () => {
      const minter = new AuthTokenMinterService(stubConfig());
      expect(
        minter.mergeScopes({ can_start_sessions: false, allowed_modes: ['a'] }, { can_start_sessions: true })
      ).toEqual({ can_start_sessions: true, allowed_modes: ['a'] });
    });

    it('null override deletes the key', () => {
      const minter = new AuthTokenMinterService(stubConfig());
      expect(
        minter.mergeScopes(
          { can_start_sessions: true, is_observer: false },
          { is_observer: null as unknown as boolean }
        )
      ).toEqual({ can_start_sessions: true });
    });

    it('no override returns base unchanged', () => {
      const minter = new AuthTokenMinterService(stubConfig());
      const base: MacpScopes = { can_start_sessions: true };
      expect(minter.mergeScopes(base)).toEqual(base);
    });
  });

  it('never logs the token body', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      global.fetch = fetchOk({ token: 'secret-jwt-body', sender: 's', expires_in_seconds: 60 });
      const minter = new AuthTokenMinterService(stubConfig());
      await minter.mintToken('s');
      for (const spy of [logSpy, warnSpy]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain('secret-jwt-body');
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
