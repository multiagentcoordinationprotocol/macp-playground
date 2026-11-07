import { Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DEFAULT_LLM_BUDGET, LlmBudgetConfig } from './llm-budget.config';
import { LlmBudgetService } from './llm-budget.service';
import { InMemoryLlmUsageStore, LlmUsageStore } from './llm-usage.store';

const T0 = Date.UTC(2026, 10, 7, 12, 0, 0); // 2026-11-07T12:00:00Z

function setup(overrides: Partial<LlmBudgetConfig> = {}, store?: LlmUsageStore) {
  let now = T0;
  const clock = () => now;
  const config = { llmBudget: { ...DEFAULT_LLM_BUDGET, databaseUrl: '', ...overrides } } as AppConfigService;
  const service = new LlmBudgetService(config, store ?? new InMemoryLlmUsageStore(clock));
  service.now = clock;
  return {
    service,
    advance: (ms: number) => {
      now += ms;
    },
    at: (ms: number) => {
      now = ms;
    }
  };
}

async function reserveN(service: LlmBudgetService, ip: string, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await service.reserve(ip));
  return out;
}

describe('LlmBudgetService', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('trips the per-IP burst limit, and the next burst window admits the IP again', async () => {
    const { service, advance } = setup({ perIpBurst: 2, perIpBurstWindowMs: 10 * 60_000 });
    const results = await reserveN(service, '203.0.113.1', 3);
    expect(results.map((r) => r.granted)).toEqual([true, true, false]);
    expect(results[2]).toEqual({ granted: false, limit: 'per_ip_burst' });
    expect(await service.reserve('203.0.113.2')).toEqual({ granted: true }); // other IPs unaffected
    advance(10 * 60_000);
    expect(await service.reserve('203.0.113.1')).toEqual({ granted: true });
  });

  it('trips the per-IP daily limit across burst windows, and resets at UTC midnight', async () => {
    const { service, advance, at } = setup({ perIpBurst: 2, perIpBurstWindowMs: 60_000, perIpDaily: 3 });
    expect((await reserveN(service, '203.0.113.1', 2)).every((r) => r.granted)).toBe(true);
    advance(60_000);
    expect(await service.reserve('203.0.113.1')).toEqual({ granted: true });
    expect(await service.reserve('203.0.113.1')).toEqual({ granted: false, limit: 'per_ip_daily' });
    at(Date.UTC(2026, 10, 8, 0, 0, 1));
    expect(await service.reserve('203.0.113.1')).toEqual({ granted: true });
  });

  it('trips the global daily limit for every IP, and resets the next UTC day', async () => {
    const { service, at } = setup({ globalDaily: 3 });
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      expect(await service.reserve(ip)).toEqual({ granted: true });
    }
    expect(await service.reserve('198.51.100.4')).toEqual({ granted: false, limit: 'global_daily' });
    at(Date.UTC(2026, 10, 8, 9, 0, 0));
    expect(await service.reserve('198.51.100.4')).toEqual({ granted: true });
  });

  it('trips the global monthly limit across days, and resets with the UTC month', async () => {
    const { service, at } = setup({ globalMonthly: 2 });
    expect(await service.reserve('198.51.100.1')).toEqual({ granted: true });
    at(Date.UTC(2026, 10, 20));
    expect(await service.reserve('198.51.100.2')).toEqual({ granted: true });
    at(Date.UTC(2026, 10, 30, 23, 59));
    expect(await service.reserve('198.51.100.3')).toEqual({ granted: false, limit: 'global_monthly' });
    at(Date.UTC(2026, 11, 1));
    expect(await service.reserve('198.51.100.3')).toEqual({ granted: true });
  });

  it('a refused launch consumes nothing on any axis', async () => {
    const { service } = setup({ perIpBurst: 1, globalDaily: 2 });
    await service.reserve('203.0.113.1');
    await service.reserve('203.0.113.1'); // refused: burst
    expect(await service.reserve('203.0.113.2')).toEqual({ granted: true }); // global still had room
    expect((await service.usage()).globalDaily.count).toBe(2);
  });

  it('a limit of 0 disables LLM launches on that axis', async () => {
    const { service } = setup({ globalDaily: 0 });
    expect(await service.reserve('203.0.113.1')).toEqual({ granted: false, limit: 'global_daily' });
  });

  it('fails closed when the store cannot be reached', async () => {
    const broken: LlmUsageStore = {
      kind: 'postgres',
      tryReserve: () => Promise.reject(new Error('connect ECONNREFUSED')),
      counts: () => Promise.reject(new Error('connect ECONNREFUSED'))
    };
    const { service } = setup({}, broken);
    expect(await service.reserve('203.0.113.1')).toEqual({ granted: false, limit: 'store_unavailable' });
  });

  it('logs a structured line when a limit trips, without the IP', async () => {
    const { service } = setup({ perIpBurst: 1 });
    await reserveN(service, '203.0.113.77', 2);
    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(line).toMatch(
      /^llm_budget_limit_tripped limit=per_ip_burst count=1 max=1 window=ip:w3600000:\d+ action=fallback store=memory$/
    );
    expect(line).not.toContain('203.0.113.77');
  });

  it('reports global usage only, never per-IP data', async () => {
    const { service } = setup();
    await reserveN(service, '203.0.113.1', 2);
    const report = await service.usage();
    expect(report).toEqual({
      store: 'memory',
      onLimit: 'fallback',
      limits: { perIpBurst: 5, perIpBurstWindowMs: 3_600_000, perIpDaily: 20, globalDaily: 200, globalMonthly: 2000 },
      globalDaily: { window: '2026-11-07', count: 2, limit: 200 },
      globalMonthly: { window: '2026-11', count: 2, limit: 2000 }
    });
    expect(JSON.stringify(report)).not.toContain('203.0.113.1');
  });
});
