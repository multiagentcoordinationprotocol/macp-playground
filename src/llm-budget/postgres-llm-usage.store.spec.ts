import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PostgresLlmUsageStore } from './postgres-llm-usage.store';

/**
 * Runs against a real Postgres when LLM_USAGE_TEST_DATABASE_URL is set (CI's `test` job provides
 * one); skipped otherwise. The table is dropped before and after, so point it at a scratch database.
 */
const url = process.env.LLM_USAGE_TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

describePg('PostgresLlmUsageStore (real Postgres)', () => {
  let admin: Pool;
  const stores: PostgresLlmUsageStore[] = [];
  const open = () => {
    const s = new PostgresLlmUsageStore(url);
    stores.push(s);
    return s;
  };
  const later = new Date(Date.now() + 60 * 60_000);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query('DROP TABLE IF EXISTS llm_usage_counters');
  });

  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()));
    await admin.query('DROP TABLE IF EXISTS llm_usage_counters');
    await admin.end();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await open().init();
    await admin.query('TRUNCATE llm_usage_counters');
  });

  it('creates its table and reserves all-or-nothing across buckets', async () => {
    const store = open();
    const a = { key: 'g:d:test', limit: 2, expiresAt: later };
    const b = { key: 'ip:x:d:test', limit: 1, expiresAt: later };
    expect(await store.tryReserve([a, b])).toEqual({ ok: true, counts: [1, 1] });
    // b is full: nothing is incremented, a included.
    expect(await store.tryReserve([a, b])).toEqual({ ok: false, index: 1, count: 1 });
    expect(await store.counts([a.key, b.key, 'missing'])).toEqual([1, 1, 0]);
  });

  it('keeps counts across a restart (a new store instance on the same database)', async () => {
    const bucket = { key: 'g:m:restart', limit: 5, expiresAt: later };
    await open().tryReserve([bucket]);
    await open().tryReserve([bucket]);
    expect(await open().counts([bucket.key])).toEqual([2]);
  });

  it('never over-grants under concurrent reservations from several replicas', async () => {
    const replicas = [open(), open(), open(), open()];
    const bucket = { key: 'g:d:race', limit: 7, expiresAt: later };
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => replicas[i % replicas.length].tryReserve([bucket]))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(7);
    expect(await replicas[0].counts([bucket.key])).toEqual([7]);
  });

  it('ignores and sweeps expired rows', async () => {
    const store = open();
    await admin.query(
      "INSERT INTO llm_usage_counters (bucket, count, expires_at) VALUES ('old', 9, now() - interval '1 minute')"
    );
    expect(await store.counts(['old'])).toEqual([0]);
    await (store as unknown as { sweep(): Promise<void> }).sweep();
    const { rows } = await admin.query("SELECT 1 FROM llm_usage_counters WHERE bucket = 'old'");
    expect(rows).toHaveLength(0);
  });
});
