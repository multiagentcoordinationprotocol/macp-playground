/** One counter an LLM launch must fit under: at most `limit` launches in the window `key` names. */
export interface UsageBucket {
  /** Unique per window, e.g. `g:d:2026-11-07`, so a new window is a new row and needs no reset. */
  key: string;
  limit: number;
  /** When the window ends; the row may be deleted after this. */
  expiresAt: Date;
}

export type ReserveResult =
  | { ok: true; counts: number[] }
  /** `index` is the first bucket (in the order given) that was already full; `count` is its usage. */
  | { ok: false; index: number; count: number };

/**
 * Durable launch counters. `tryReserve` is all-or-nothing: either every bucket is under its limit
 * and each is incremented, or none changes. Implementations must be correct when several replicas
 * reserve at once.
 */
export interface LlmUsageStore {
  readonly kind: 'postgres' | 'memory';
  tryReserve(buckets: UsageBucket[]): Promise<ReserveResult>;
  /** Current counts for `keys` (0 for a key with no row). */
  counts(keys: string[]): Promise<number[]>;
}

export const LLM_USAGE_STORE = Symbol('LLM_USAGE_STORE');

/**
 * Process-local counters. Correct only for a single replica, and reset on every restart, so the
 * service uses it only when no `LLM_USAGE_DATABASE_URL` is set, and refuses that combination in
 * production while LLM agents are allowed (see AppConfigService). Local development and tests.
 */
export class InMemoryLlmUsageStore implements LlmUsageStore {
  readonly kind = 'memory' as const;
  private readonly rows = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async tryReserve(buckets: UsageBucket[]): Promise<ReserveResult> {
    this.sweep();
    const current = buckets.map((b) => this.rows.get(b.key)?.count ?? 0);
    const full = buckets.findIndex((b, i) => current[i] >= b.limit);
    if (full >= 0) return { ok: false, index: full, count: current[full] };
    buckets.forEach((b, i) => this.rows.set(b.key, { count: current[i] + 1, expiresAt: b.expiresAt.getTime() }));
    return { ok: true, counts: current.map((c) => c + 1) };
  }

  async counts(keys: string[]): Promise<number[]> {
    this.sweep();
    return keys.map((k) => this.rows.get(k)?.count ?? 0);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, row] of this.rows) if (row.expiresAt <= now) this.rows.delete(key);
  }
}
