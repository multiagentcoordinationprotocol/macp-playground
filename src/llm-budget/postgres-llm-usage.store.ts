import { Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { LlmUsageStore, ReserveResult, UsageBucket } from './llm-usage.store';

const TABLE = 'llm_usage_counters';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Counters in Postgres, shared by every replica and kept across restarts.
 *
 * `tryReserve` upserts each bucket inside one transaction (`INSERT … ON CONFLICT DO UPDATE …
 * RETURNING count`). The upsert row-locks the counter until COMMIT/ROLLBACK, so concurrent
 * reservations against the same bucket serialize and the count each one sees is exact; if any
 * bucket comes back over its limit the whole transaction rolls back. Buckets are always given in the
 * same order (global month, global day, per-IP day, per-IP burst), so two transactions cannot take
 * the same locks in opposite orders and deadlock.
 *
 * Rows hold only a bucket key (per-IP keys carry a truncated SHA-256 of the IP, never the IP), a
 * count and an expiry. Expired rows are deleted at start-up and hourly.
 */
export class PostgresLlmUsageStore implements LlmUsageStore, OnModuleInit, OnApplicationShutdown {
  readonly kind = 'postgres' as const;
  private readonly logger = new Logger(PostgresLlmUsageStore.name);
  private readonly pool: Pool;
  private ready: Promise<void> | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(connectionString: string, pool?: Pool) {
    this.pool =
      pool ?? new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 });
    // An idle client's connection error must not crash the process; the next query reports it.
    this.pool.on('error', (err) => this.logger.warn(`llm_usage_store_pool_error reason=${err.message}`));
  }

  /** Boot does not wait on, or fail for, the database: a reservation retries `init` and fails closed. */
  async onModuleInit(): Promise<void> {
    try {
      await this.init();
      this.logger.log('llm usage store: postgres ready');
    } catch (err) {
      this.logger.error(`llm_usage_store_init_failed reason=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  /** Create the table if needed and start the hourly sweep. Safe to call more than once. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
           bucket text PRIMARY KEY,
           count integer NOT NULL,
           expires_at timestamptz NOT NULL
         )`
      );
      await this.sweep();
      this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref();
    })().catch((err: unknown) => {
      this.ready = undefined; // retry on the next call
      throw err;
    });
    return this.ready;
  }

  async tryReserve(buckets: UsageBucket[]): Promise<ReserveResult> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const counts: number[] = [];
      for (const [index, bucket] of buckets.entries()) {
        const { rows } = await client.query<{ count: number }>(
          `INSERT INTO ${TABLE} (bucket, count, expires_at) VALUES ($1, 1, $2)
           ON CONFLICT (bucket) DO UPDATE SET count = ${TABLE}.count + 1
           RETURNING count`,
          [bucket.key, bucket.expiresAt]
        );
        const count = Number(rows[0].count);
        if (count > bucket.limit) {
          await client.query('ROLLBACK');
          return { ok: false, index, count: count - 1 };
        }
        counts.push(count);
      }
      await client.query('COMMIT');
      return { ok: true, counts };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async counts(keys: string[]): Promise<number[]> {
    await this.init();
    const { rows } = await this.pool.query<{ bucket: string; count: number }>(
      `SELECT bucket, count FROM ${TABLE} WHERE bucket = ANY($1) AND expires_at > now()`,
      [keys]
    );
    const byKey = new Map(rows.map((r) => [r.bucket, Number(r.count)]));
    return keys.map((k) => byKey.get(k) ?? 0);
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.pool.end();
  }

  private async sweep(): Promise<void> {
    try {
      await this.pool.query(`DELETE FROM ${TABLE} WHERE expires_at <= now()`);
    } catch (err) {
      this.logger.warn(`llm_usage_store_sweep_failed reason=${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
