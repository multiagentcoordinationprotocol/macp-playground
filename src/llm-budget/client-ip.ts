import { isIP } from 'node:net';
import { isValidApiKey } from '../middleware/api-key';

/**
 * The end user's IP, as forwarded by the ui-console's server-side proxy. Every legitimate request
 * reaches the playground from Vercel, so the connecting address (and the `X-Forwarded-For` hop
 * Railway adds) is Vercel's, shared by every console user. The proxy therefore names the user in
 * this header, and the playground believes it only on a request that also carries a valid API key:
 * anyone without the key cannot choose the IP their launches are counted against.
 */
export const CLIENT_IP_HEADER = 'x-macp-client-ip';

export interface ClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined };
  ip?: string;
}

export interface ResolvedClientIp {
  ip: string;
  /** `client-header`: X-MACP-Client-IP on a keyed request. `proxy-hop`: the trusted-proxy address. */
  source: 'client-header' | 'proxy-hop';
}

function normalizeIp(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']')); // [v6]:port
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7); // v4-mapped v6
  return isIP(ip) ? ip : undefined;
}

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(','));
}

/**
 * The client address as seen by the outermost proxy this service trusts. Each trusted proxy
 * appends the address it received the request from to `X-Forwarded-For`, so with `hops` trusted
 * proxies the client is the `hops`-th entry from the right; everything left of it was written by
 * the caller and is ignored. With `hops` 0, or fewer entries than `hops` (the request did not come
 * through the proxies), the socket's peer address is used.
 */
export function proxyHopIp(req: ClientIpRequest, trustedProxyHops: number): string {
  const socketIp = normalizeIp(req.socket?.remoteAddress) ?? normalizeIp(req.ip) ?? 'unknown';
  if (trustedProxyHops <= 0) return socketIp;
  const chain = headerValues(req.headers['x-forwarded-for'])
    .map((v) => v.trim())
    .filter(Boolean);
  if (chain.length < trustedProxyHops) return socketIp;
  return normalizeIp(chain[chain.length - trustedProxyHops]) ?? socketIp;
}

/**
 * The IP that per-client limits are keyed on. `X-MACP-Client-IP` wins only when the request also
 * carries a valid `x-api-key` and the header holds exactly one well-formed IP; otherwise it is
 * ignored and the trusted-proxy address is used.
 */
export function resolveClientIp(
  req: ClientIpRequest,
  apiKeys: readonly string[],
  trustedProxyHops: number
): ResolvedClientIp {
  const forwarded = req.headers[CLIENT_IP_HEADER];
  if (typeof forwarded === 'string' && !forwarded.includes(',') && isValidApiKey(req.headers['x-api-key'], apiKeys)) {
    const ip = normalizeIp(forwarded);
    if (ip) return { ip, source: 'client-header' };
  }
  return { ip: proxyHopIp(req, trustedProxyHops), source: 'proxy-hop' };
}
