import { AppConfigService } from '../config/app-config.service';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

describe('ClientIpThrottlerGuard', () => {
  // getTracker only reads the injected config; build the guard without the throttler's own deps.
  const guard = Object.create(ClientIpThrottlerGuard.prototype) as unknown as {
    appConfig: AppConfigService;
    getTracker(req: Record<string, unknown>): Promise<string>;
  };
  guard.appConfig = { authApiKeys: ['console-key'], trustedProxyHops: 1 } as AppConfigService;

  it('throttles per end user behind the console proxy, not per proxy address', async () => {
    const viaConsole = (ip: string) => ({
      headers: { 'x-api-key': 'console-key', 'x-macp-client-ip': ip, 'x-forwarded-for': '76.76.21.9' },
      socket: { remoteAddress: '10.0.0.2' }
    });
    expect(await guard.getTracker(viaConsole('203.0.113.1'))).toBe('203.0.113.1');
    expect(await guard.getTracker(viaConsole('203.0.113.2'))).toBe('203.0.113.2');
  });

  it('uses the trusted proxy hop for a caller without the key', async () => {
    const req = { headers: { 'x-macp-client-ip': '203.0.113.1', 'x-forwarded-for': '9.9.9.9, 198.51.100.4' } };
    expect(await guard.getTracker(req)).toBe('198.51.100.4');
  });
});
