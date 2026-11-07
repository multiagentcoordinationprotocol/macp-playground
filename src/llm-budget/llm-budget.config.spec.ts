import { DEFAULT_LLM_BUDGET, readLlmBudgetConfig } from './llm-budget.config';

describe('readLlmBudgetConfig', () => {
  it('defaults to 5/hour and 20/day per IP, 200/day and 2000/month globally, fallback, in-memory', () => {
    expect(readLlmBudgetConfig({})).toEqual({ ...DEFAULT_LLM_BUDGET, databaseUrl: '' });
    expect(DEFAULT_LLM_BUDGET).toEqual({
      perIpBurst: 5,
      perIpBurstWindowMs: 3_600_000,
      perIpDaily: 20,
      globalDaily: 200,
      globalMonthly: 2000,
      onLimit: 'fallback'
    });
  });

  it('reads every limit from the environment', () => {
    expect(
      readLlmBudgetConfig({
        LLM_LIMIT_PER_IP_BURST: '2',
        LLM_LIMIT_PER_IP_BURST_WINDOW_MS: '600000',
        LLM_LIMIT_PER_IP_DAILY: '7',
        LLM_LIMIT_GLOBAL_DAILY: '50',
        LLM_LIMIT_GLOBAL_MONTHLY: '500',
        LLM_LIMIT_ACTION: 'REJECT',
        LLM_USAGE_DATABASE_URL: ' postgres://u@h/db '
      })
    ).toEqual({
      perIpBurst: 2,
      perIpBurstWindowMs: 600_000,
      perIpDaily: 7,
      globalDaily: 50,
      globalMonthly: 500,
      onLimit: 'reject',
      databaseUrl: 'postgres://u@h/db'
    });
  });

  it('allows 0 (no LLM launches) but never lets a bad value lift a limit', () => {
    const cfg = readLlmBudgetConfig({
      LLM_LIMIT_GLOBAL_DAILY: '0',
      LLM_LIMIT_GLOBAL_MONTHLY: '-1',
      LLM_LIMIT_PER_IP_DAILY: 'lots',
      LLM_LIMIT_PER_IP_BURST: '2.5',
      LLM_LIMIT_PER_IP_BURST_WINDOW_MS: '10',
      LLM_LIMIT_ACTION: 'whatever'
    });
    expect(cfg.globalDaily).toBe(0);
    expect(cfg.globalMonthly).toBe(DEFAULT_LLM_BUDGET.globalMonthly);
    expect(cfg.perIpDaily).toBe(DEFAULT_LLM_BUDGET.perIpDaily);
    expect(cfg.perIpBurst).toBe(DEFAULT_LLM_BUDGET.perIpBurst);
    expect(cfg.perIpBurstWindowMs).toBe(DEFAULT_LLM_BUDGET.perIpBurstWindowMs);
    expect(cfg.onLimit).toBe('fallback');
  });
});
