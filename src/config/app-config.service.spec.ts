import { Logger } from '@nestjs/common';
import { AppConfigService, readBoolean, readNumber, readStringList } from './app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

describe('readBoolean', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
  });

  afterAll(() => {
    process.env = original;
  });

  it('should return default when env var is not set', () => {
    delete process.env.TEST_BOOL;
    expect(readBoolean('TEST_BOOL', true)).toBe(true);
    expect(readBoolean('TEST_BOOL', false)).toBe(false);
  });

  it('should parse truthy values', () => {
    for (const val of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes']) {
      process.env.TEST_BOOL = val;
      expect(readBoolean('TEST_BOOL')).toBe(true);
    }
  });

  it('should parse falsy values', () => {
    for (const val of ['0', 'false', 'no', 'off', 'anything']) {
      process.env.TEST_BOOL = val;
      expect(readBoolean('TEST_BOOL')).toBe(false);
    }
  });
});

describe('readNumber', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
  });

  afterAll(() => {
    process.env = original;
  });

  it('should return default when env var is not set', () => {
    delete process.env.TEST_NUM;
    expect(readNumber('TEST_NUM', 42)).toBe(42);
  });

  it('should parse valid numbers', () => {
    process.env.TEST_NUM = '3000';
    expect(readNumber('TEST_NUM', 0)).toBe(3000);
  });

  it('should return default for non-numeric values', () => {
    process.env.TEST_NUM = 'abc';
    expect(readNumber('TEST_NUM', 99)).toBe(99);
  });
});

describe('readStringList', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
  });

  afterAll(() => {
    process.env = original;
  });

  it('should return empty array when env var is not set', () => {
    delete process.env.TEST_LIST;
    expect(readStringList('TEST_LIST')).toEqual([]);
  });

  it('should return empty array for empty string', () => {
    process.env.TEST_LIST = '';
    expect(readStringList('TEST_LIST')).toEqual([]);
  });

  it('should split comma-separated values and trim whitespace', () => {
    process.env.TEST_LIST = 'key1, key2 , key3';
    expect(readStringList('TEST_LIST')).toEqual(['key1', 'key2', 'key3']);
  });
});

describe('AppConfigService', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    process.env.MACP_AUTH_SERVICE_URL = 'http://auth:3200';
  });

  afterAll(() => {
    process.env = original;
  });

  it('should use default values', () => {
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.PACKS_DIR;
    delete process.env.REGISTRY_CACHE_TTL_MS;
    delete process.env.MACP_RUNTIME_ADDRESS;
    delete process.env.MACP_RUNTIME_TLS;
    delete process.env.MACP_RUNTIME_ALLOW_INSECURE;
    const config = new AppConfigService();
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.packsDir).toBe('./packs');
    expect(config.registryCacheTtlMs).toBe(0);
    expect(config.runtimeAddress).toBe('');
    expect(config.runtimeTls).toBe(true);
    expect(config.runtimeAllowInsecure).toBe(false);
  });

  it('should read from environment variables', () => {
    process.env.PORT = '4000';
    process.env.PACKS_DIR = '/custom/packs';
    process.env.REGISTRY_CACHE_TTL_MS = '60000';
    const config = new AppConfigService();
    expect(config.port).toBe(4000);
    expect(config.packsDir).toBe('/custom/packs');
    expect(config.registryCacheTtlMs).toBe(60000);
  });

  it('honors MACP_RUNTIME_ADDRESS/TLS/ALLOW_INSECURE', () => {
    process.env.MACP_RUNTIME_ADDRESS = 'runtime.local:50051';
    process.env.MACP_RUNTIME_TLS = 'false';
    process.env.MACP_RUNTIME_ALLOW_INSECURE = 'true';
    const config = new AppConfigService();
    expect(config.runtimeAddress).toBe('runtime.local:50051');
    expect(config.runtimeTls).toBe(false);
    expect(config.runtimeAllowInsecure).toBe(true);
  });

  describe('auth config (MACP_AUTH_*)', () => {
    it('reads auth-service URL / timeout / TTL', () => {
      process.env.MACP_AUTH_SERVICE_URL = 'http://auth:3200';
      process.env.MACP_AUTH_SERVICE_TIMEOUT_MS = '7500';
      process.env.MACP_AUTH_TOKEN_TTL_SECONDS = '900';
      const config = new AppConfigService();
      expect(config.authServiceUrl).toBe('http://auth:3200');
      expect(config.authServiceTimeoutMs).toBe(7500);
      expect(config.authTokenTtlSeconds).toBe(900);
      expect(config.authScopeOverrides).toEqual({});
    });

    it('falls back to the 5000ms default when MACP_AUTH_SERVICE_TIMEOUT_MS is invalid', () => {
      // AuthTokenMinterService.requestToken passes this straight into
      // AbortSignal.timeout(), which throws on an invalid value — and unlike
      // the control-plane client, that throw is fatal (AUTH_MINT_FAILED,
      // 502) rather than a caught, logged, non-fatal warn. A misconfigured
      // value here breaks every single agent spawn, not just CP-1 submission.
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      process.env.MACP_AUTH_SERVICE_TIMEOUT_MS = '-1';
      const config = new AppConfigService();
      expect(config.authServiceTimeoutMs).toBe(5000);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MACP_AUTH_SERVICE_TIMEOUT_MS'));
      warnSpy.mockRestore();
    });

    it('onModuleInit throws INVALID_CONFIG when MACP_AUTH_SERVICE_URL is missing', () => {
      delete process.env.MACP_AUTH_SERVICE_URL;
      const config = new AppConfigService();
      try {
        config.onModuleInit();
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_CONFIG);
        expect((err as AppException).message).toMatch(/MACP_AUTH_SERVICE_URL/);
      }
    });

    it('onModuleInit throws INVALID_CONFIG when MACP_AUTH_TOKEN_TTL_SECONDS is non-positive', () => {
      process.env.MACP_AUTH_TOKEN_TTL_SECONDS = '0';
      const config = new AppConfigService();
      try {
        config.onModuleInit();
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_CONFIG);
        expect((err as AppException).message).toMatch(/MACP_AUTH_TOKEN_TTL_SECONDS/);
      }
    });

    it('parses MACP_AUTH_SCOPES_JSON per-sender overrides', () => {
      process.env.MACP_AUTH_SCOPES_JSON =
        '{"risk-agent":{"can_start_sessions":true},"analyst":{"is_observer":true,"allowed_modes":["macp.mode.decision.v1"]}}';
      const config = new AppConfigService();
      expect(config.authScopeOverrides['risk-agent']).toEqual({ can_start_sessions: true });
      expect(config.authScopeOverrides['analyst']).toEqual({
        is_observer: true,
        allowed_modes: ['macp.mode.decision.v1']
      });
    });

    it('throws INVALID_CONFIG when MACP_AUTH_SCOPES_JSON is malformed', () => {
      process.env.MACP_AUTH_SCOPES_JSON = '[]';
      try {
        new AppConfigService();
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_CONFIG);
      }
    });
  });

  describe('control-plane config (MACP_CONTROL_PLANE_*)', () => {
    it('defaults controlPlaneUrl/apiKey to empty and controlPlaneTimeoutMs to 5000', () => {
      delete process.env.MACP_CONTROL_PLANE_URL;
      delete process.env.MACP_CONTROL_PLANE_TIMEOUT_MS;
      delete process.env.MACP_CONTROL_PLANE_API_KEY;
      const config = new AppConfigService();
      expect(config.controlPlaneUrl).toBe('');
      expect(config.controlPlaneTimeoutMs).toBe(5000);
      expect(config.controlPlaneApiKey).toBe('');
    });

    it('reads a valid MACP_CONTROL_PLANE_TIMEOUT_MS as-is', () => {
      process.env.MACP_CONTROL_PLANE_TIMEOUT_MS = '2500';
      const config = new AppConfigService();
      expect(config.controlPlaneTimeoutMs).toBe(2500);
    });

    it.each([
      ['0', 'zero'],
      ['-100', 'negative'],
      ['1500.5', 'non-integer'],
      ['not-a-number', 'unparseable'],
      // AbortSignal.timeout()'s ceiling is 4294967295 (2^32-1, unsigned
      // 32-bit max, verified empirically); one past it throws a RangeError
      // just like the negative/non-integer cases do.
      ['4294967296', 'exceeds AbortSignal.timeout() max (2^32-1)']
    ])('falls back to the 5000ms default when MACP_CONTROL_PLANE_TIMEOUT_MS is %s (%s)', (value) => {
      process.env.MACP_CONTROL_PLANE_TIMEOUT_MS = value;
      const config = new AppConfigService();
      expect(config.controlPlaneTimeoutMs).toBe(5000);
    });

    it('accepts 4294967295 (2^32-1), the exact AbortSignal.timeout() ceiling', () => {
      process.env.MACP_CONTROL_PLANE_TIMEOUT_MS = '4294967295';
      const config = new AppConfigService();
      expect(config.controlPlaneTimeoutMs).toBe(4294967295);
    });

    it('warns when MACP_CONTROL_PLANE_TIMEOUT_MS is invalid', () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      process.env.MACP_CONTROL_PLANE_TIMEOUT_MS = '-1';
      new AppConfigService();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MACP_CONTROL_PLANE_TIMEOUT_MS'));
      warnSpy.mockRestore();
    });
  });
});
