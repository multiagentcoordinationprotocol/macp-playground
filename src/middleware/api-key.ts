import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * True when `presented` equals one of `keys`, compared in constant time. Both sides are hashed
 * first so `timingSafeEqual` always sees equal-length buffers (a raw compare would leak the key's
 * length), and every configured key is compared, so the time taken does not reveal which key, if
 * any, matched. An empty key list matches nothing.
 */
export function isValidApiKey(presented: unknown, keys: readonly string[]): boolean {
  if (typeof presented !== 'string' || presented === '' || keys.length === 0) return false;
  const candidate = digest(presented);
  let matched = false;
  for (const key of keys) {
    // Evaluate the comparison before the OR so no key is skipped once one has matched.
    matched = timingSafeEqual(candidate, digest(key)) || matched;
  }
  return matched;
}
