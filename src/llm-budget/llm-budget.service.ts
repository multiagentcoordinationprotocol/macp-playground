import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { DEFAULT_LLM_BUDGET, LlmBudgetConfig } from './llm-budget.config';
import { LLM_USAGE_STORE, LlmUsageStore, UsageBucket } from './llm-usage.store';

export type LlmLimitName = 'global_monthly' | 'global_daily' | 'per_ip_daily' | 'per_ip_burst' | 'store_unavailable';

export type LlmBudgetDecision = { granted: true } | { granted: false; limit: LlmLimitName };

export interface LlmUsageWindow {
  window: string;
  count: number;
  limit: number;
}

export interface LlmUsageReport {
  store: LlmUsageStore['kind'];
  onLimit: LlmBudgetConfig['onLimit'];
  limits: Omit<LlmBudgetConfig, 'databaseUrl' | 'onLimit'>;
  globalDaily: LlmUsageWindow;
  globalMonthly: LlmUsageWindow;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Truncated SHA-256: per-IP rows and logs never hold the address itself. */
function ipTag(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

/**
 * Budget for LLM-backed launches: per client IP (a burst window and a UTC day) and across all
 * callers (a UTC day and a UTC calendar month, the hard spend ceiling). Windows are fixed, not
 * sliding: a caller can land up to twice a window's limit across a window boundary, which the
 * daily and monthly ceilings still bound. A launch is counted when it is granted, whether or not
 * the session later completes.
 */
@Injectable()
export class LlmBudgetService {
  private readonly logger = new Logger(LlmBudgetService.name);

  constructor(
    private readonly config: AppConfigService,
    @Inject(LLM_USAGE_STORE) private readonly store: LlmUsageStore
  ) {}

  /** Clock, replaceable in tests. */
  now: () => number = Date.now;

  get budget(): LlmBudgetConfig {
    return this.config.llmBudget ?? { ...DEFAULT_LLM_BUDGET, databaseUrl: '' };
  }

  /** Reserve one LLM launch for `clientIp`, or name the first limit it would exceed. */
  async reserve(clientIp: string): Promise<LlmBudgetDecision> {
    const budget = this.budget;
    const at = new Date(this.now());
    const tag = ipTag(clientIp);
    const named: Array<[LlmLimitName, UsageBucket]> = [
      ['global_monthly', this.monthBucket('g:m', budget.globalMonthly, at)],
      ['global_daily', this.dayBucket('g:d', budget.globalDaily, at)],
      ['per_ip_daily', this.dayBucket(`ip:${tag}:d`, budget.perIpDaily, at)],
      ['per_ip_burst', this.burstBucket(`ip:${tag}:w${budget.perIpBurstWindowMs}`, budget, at)]
    ];

    let result;
    try {
      result = await this.store.tryReserve(named.map(([, b]) => b));
    } catch (err) {
      // Fail closed: if the counters cannot be read, no launch may spend the key.
      this.logger.error(
        `llm_budget_limit_tripped limit=store_unavailable action=${budget.onLimit} store=${this.store.kind} ` +
          `reason=${err instanceof Error ? err.message : String(err)}`
      );
      return { granted: false, limit: 'store_unavailable' };
    }

    if (!result.ok) {
      const [limit, bucket] = named[result.index];
      this.logger.warn(
        `llm_budget_limit_tripped limit=${limit} count=${result.count} max=${bucket.limit} window=${bucket.key.replace(/^ip:[0-9a-f]+:/, 'ip:')} ` +
          `action=${budget.onLimit} store=${this.store.kind}`
      );
      return { granted: false, limit };
    }

    const [monthly, daily] = result.counts;
    this.logger.log(
      `llm_budget_reserved globalDaily=${daily}/${budget.globalDaily} globalMonthly=${monthly}/${budget.globalMonthly} store=${this.store.kind}`
    );
    return { granted: true };
  }

  /** Global counts only: never per-IP data. */
  async usage(): Promise<LlmUsageReport> {
    const budget = this.budget;
    const at = new Date(this.now());
    const day = this.dayBucket('g:d', budget.globalDaily, at);
    const month = this.monthBucket('g:m', budget.globalMonthly, at);
    const [dayCount, monthCount] = await this.store.counts([day.key, month.key]);
    const { perIpBurst, perIpBurstWindowMs, perIpDaily, globalDaily, globalMonthly, onLimit } = budget;
    return {
      store: this.store.kind,
      onLimit,
      limits: { perIpBurst, perIpBurstWindowMs, perIpDaily, globalDaily, globalMonthly },
      globalDaily: { window: day.key.slice(4), count: dayCount, limit: budget.globalDaily },
      globalMonthly: { window: month.key.slice(4), count: monthCount, limit: budget.globalMonthly }
    };
  }

  private dayBucket(prefix: string, limit: number, at: Date): UsageBucket {
    const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    return { key: `${prefix}:${at.toISOString().slice(0, 10)}`, limit, expiresAt: new Date(start + DAY_MS) };
  }

  private monthBucket(prefix: string, limit: number, at: Date): UsageBucket {
    const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
    return { key: `${prefix}:${at.toISOString().slice(0, 7)}`, limit, expiresAt: new Date(end) };
  }

  private burstBucket(prefix: string, budget: LlmBudgetConfig, at: Date): UsageBucket {
    const windowMs = budget.perIpBurstWindowMs;
    const index = Math.floor(at.getTime() / windowMs);
    return { key: `${prefix}:${index}`, limit: budget.perIpBurst, expiresAt: new Date((index + 1) * windowMs) };
  }
}
