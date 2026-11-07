import { ClientIpRequest, proxyHopIp, resolveClientIp } from './client-ip';

const KEYS = ['console-key'];

function req(headers: ClientIpRequest['headers'], remoteAddress = '10.0.0.2'): ClientIpRequest {
  return { headers, socket: { remoteAddress } };
}

describe('proxyHopIp', () => {
  it('uses the socket peer when no proxy is trusted, ignoring X-Forwarded-For', () => {
    expect(proxyHopIp(req({ 'x-forwarded-for': '203.0.113.1' }), 0)).toBe('10.0.0.2');
  });

  it('takes the entry the trusted proxy appended (rightmost), not what the caller wrote', () => {
    // Caller sent "X-Forwarded-For: 1.2.3.4"; Railway's edge appended the real peer.
    expect(proxyHopIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.20' }), 1)).toBe('198.51.100.20');
    expect(proxyHopIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.20, 10.1.1.1' }), 2)).toBe('198.51.100.20');
  });

  it('joins repeated X-Forwarded-For headers before counting hops', () => {
    expect(proxyHopIp(req({ 'x-forwarded-for': ['1.2.3.4', '198.51.100.20'] }), 1)).toBe('198.51.100.20');
  });

  it('falls back to the socket peer when the chain is shorter than the trusted hops or malformed', () => {
    expect(proxyHopIp(req({}), 1)).toBe('10.0.0.2');
    expect(proxyHopIp(req({ 'x-forwarded-for': '198.51.100.20' }), 2)).toBe('10.0.0.2');
    expect(proxyHopIp(req({ 'x-forwarded-for': '1.2.3.4, not-an-ip' }), 1)).toBe('10.0.0.2');
  });

  it('normalizes IPv4-mapped IPv6 and bracketed addresses', () => {
    expect(proxyHopIp(req({}, '::ffff:192.0.2.5'), 0)).toBe('192.0.2.5');
    expect(proxyHopIp(req({ 'x-forwarded-for': '[2001:DB8::1]:443' }), 1)).toBe('2001:db8::1');
  });

  it('reports unknown when there is no usable address at all', () => {
    expect(proxyHopIp({ headers: {} }, 0)).toBe('unknown');
  });
});

describe('resolveClientIp', () => {
  const viaRailway = { 'x-forwarded-for': '76.76.21.9' }; // Vercel's egress, appended by Railway

  it('trusts X-MACP-Client-IP on a request carrying the valid API key', () => {
    expect(
      resolveClientIp(req({ ...viaRailway, 'x-api-key': 'console-key', 'x-macp-client-ip': '203.0.113.50' }), KEYS, 1)
    ).toEqual({ ip: '203.0.113.50', source: 'client-header' });
  });

  it('ignores X-MACP-Client-IP without a key, with a wrong key, or with no keys configured (spoofing)', () => {
    const spoof = { ...viaRailway, 'x-macp-client-ip': '203.0.113.50' };
    expect(resolveClientIp(req(spoof), KEYS, 1)).toEqual({ ip: '76.76.21.9', source: 'proxy-hop' });
    expect(resolveClientIp(req({ ...spoof, 'x-api-key': 'guess' }), KEYS, 1).ip).toBe('76.76.21.9');
    expect(resolveClientIp(req({ ...spoof, 'x-api-key': 'console-key' }), [], 1).ip).toBe('76.76.21.9');
  });

  it('ignores a list, a malformed value or a repeated X-MACP-Client-IP even with the key', () => {
    for (const value of ['203.0.113.50, 1.2.3.4', 'not-an-ip', '', ['203.0.113.50', '1.2.3.4']]) {
      expect(
        resolveClientIp(req({ ...viaRailway, 'x-api-key': 'console-key', 'x-macp-client-ip': value }), KEYS, 1)
      ).toEqual({ ip: '76.76.21.9', source: 'proxy-hop' });
    }
  });

  it('cannot be steered through X-Forwarded-For by a caller without the key', () => {
    expect(resolveClientIp(req({ 'x-forwarded-for': '203.0.113.50, 76.76.21.9' }), KEYS, 1).ip).toBe('76.76.21.9');
  });
});
