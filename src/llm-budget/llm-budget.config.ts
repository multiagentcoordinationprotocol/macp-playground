/** What a launch gets when an LLM limit is hit. */
export type LlmLimitAction = 'fallback' | 'reject';

export interface LlmBudgetConfig {
  /** LLM launches per client IP per burst window. */
  perIpBurst: number;
  perIpBurstWindowMs: number;
  /** LLM launches per client IP per UTC day. */
  perIpDaily: number;
  /** LLM launches across all callers per UTC day: the daily budget ceiling. */
  globalDaily: number;
  /** LLM launches across all callers per UTC calendar month: the monthly budget ceiling. */
  globalMonthly: number;
  /** `fallback` (default): run the launch with deterministic agents, marked. `reject`: 429. */
  onLimit: LlmLimitAction;
  /** Postgres for the counters. Empty: process-local counters (single replica, reset on restart). */
  databaseUrl: string;
}

export const DEFAULT_LLM_BUDGET: Readonly<Omit<LlmBudgetConfig, 'databaseUrl'>> = {
  perIpBurst: 5,
  perIpBurstWindowMs: 60 * 60 * 1000,
  perIpDaily: 20,
  globalDaily: 200,
  globalMonthly: 2000,
  onLimit: 'fallback'
};

function readLimit(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

/**
 * Reads the LLM budget from the environment. A limit of 0 allows no LLM launch on that axis; an
 * unparsable or negative value falls back to the default rather than silently lifting the limit.
 */
export function readLlmBudgetConfig(env: NodeJS.ProcessEnv = process.env): LlmBudgetConfig {
  const action = (env.LLM_LIMIT_ACTION ?? '').trim().toLowerCase();
  return {
    perIpBurst: readLimit(env, 'LLM_LIMIT_PER_IP_BURST', DEFAULT_LLM_BUDGET.perIpBurst),
    perIpBurstWindowMs: readLimit(env, 'LLM_LIMIT_PER_IP_BURST_WINDOW_MS', DEFAULT_LLM_BUDGET.perIpBurstWindowMs, 1000),
    perIpDaily: readLimit(env, 'LLM_LIMIT_PER_IP_DAILY', DEFAULT_LLM_BUDGET.perIpDaily),
    globalDaily: readLimit(env, 'LLM_LIMIT_GLOBAL_DAILY', DEFAULT_LLM_BUDGET.globalDaily),
    globalMonthly: readLimit(env, 'LLM_LIMIT_GLOBAL_MONTHLY', DEFAULT_LLM_BUDGET.globalMonthly),
    onLimit: action === 'reject' ? 'reject' : 'fallback',
    databaseUrl: (env.LLM_USAGE_DATABASE_URL ?? '').trim()
  };
}
