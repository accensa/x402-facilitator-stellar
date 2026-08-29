/**
 * Rate-limit stores.
 *
 * Issue #94: move limiter state off per-process memory onto a shared store.
 * The limiter (src/rate-limit.js) reaches the buckets only through this
 * interface:
 *
 *   get(bucketId)                  -> { count, resetAt } | undefined
 *   increment(bucketId, amount, resetAtSec)
 *                                  -> { count, resetAt }   (atomic)
 *   sweep(nowSec)                  -> void
 *   close()                        -> void                 (optional)
 *
 * BACKEND CHOICE: Postgres, not Redis. Postgres is already provisioned in
 * docker-compose.yml (DATABASE_URL), so no second datastore enters the stack;
 * its UPSERT ... RETURNING gives an atomic read-modify-write; and a Postgres
 * row is never silently evicted. A fee counter is a value that must not be
 * lost on eviction — a Redis instance under memory pressure with a
 * maxmemory-policy like allkeys-lru would drop exactly the daily-fee bucket
 * this issue exists to make durable, re-creating the bug. If Redis is ever
 * introduced for this table it must be configured with noeviction and sized
 * accordingly.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The default store: a plain Map in the process. A free testnet instance must
 * start with no database and no configuration; this is what makes that true,
 * and it is byte-for-byte the behaviour the service had before #94.
 */
export class MemoryStore {
  constructor(maxSize = 10000) {
    this.map = new Map();
    this.maxSize = maxSize;
  }

  async get(bucketId, nowSec) {
    const bucket = this.map.get(bucketId);
    if (!bucket || bucket.resetAt <= nowSec) return undefined;
    return { count: bucket.count, resetAt: bucket.resetAt };
  }

  /**
   * Atomic because Node runs this synchronously between awaits: two callers in
   * one process cannot interleave inside it. Cross-process atomicity is the
   * job of the shared stores below.
   */
  async increment(bucketId, amount, resetAtSec, nowSec) {
    let bucket = this.map.get(bucketId);
    if (!bucket || bucket.resetAt <= nowSec) {
      bucket = { count: 0, resetAt: resetAtSec };
      this.map.set(bucketId, bucket);
    }
    bucket.count += amount;

    // Cap the store size by shedding oldest buckets when limit is hit
    if (this.map.size > this.maxSize) {
      const entries = Array.from(this.map.entries());
      // Sort by resetAt ascending (oldest first)
      entries.sort((a, b) => a[1].resetAt - b[1].resetAt);
      // Remove the oldest entries to get back under the limit
      const toRemove = entries.slice(0, this.map.size - this.maxSize);
      for (const [id] of toRemove) {
        this.map.delete(id);
      }
    }

    return { count: bucket.count, resetAt: bucket.resetAt };
  }

  async sweep(nowSec) {
    for (const [id, bucket] of this.map.entries()) {
      // Defensive: evict buckets without finite resetAt (malformed entries)
      if (!Number.isFinite(bucket.resetAt) || bucket.resetAt <= nowSec) {
        this.map.delete(id);
      }
    }
  }
}

/**
 * Shared store backed by Postgres.
 *
 * Every write is a single-statement upsert, so n replicas incrementing the
 * same window lose no counts — the read-modify-write happens inside the
 * database, not in Node.
 *
 * `pool` is injectable so tests can exercise the statement semantics without a
 * live server; production passes a connectionString.
 */
export class PostgresStore {
  constructor({ connectionString, pool } = {}) {
    const { Pool } = require('pg');
    this._ownsPool = !pool;
    this.pool =
      pool ??
      new Pool({
        connectionString,
        // Bounded so an unreachable store fails requests fast (the limiter's
        // degrade path, see rate-limit.js) instead of hanging them.
        connectionTimeoutMillis: 3000,
      });
    this.ready = this._ensureTable();
  }

  async _ensureTable() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        bucket_id TEXT PRIMARY KEY,
        count     BIGINT NOT NULL DEFAULT 0,
        reset_at  BIGINT NOT NULL
      )
    `);
  }

  async _awaitReady() {
    await this.ready;
  }

  async get(bucketId, nowSec) {
    await this._awaitReady();
    const { rows } = await this.pool.query(
      'SELECT count, reset_at FROM rate_limit_buckets WHERE bucket_id = $1 AND reset_at > $2',
      [bucketId, nowSec],
    );
    if (rows.length === 0) return undefined;
    return { count: Number(rows[0].count), resetAt: Number(rows[0].resetAt) };
  }

  /**
   * Atomic increment-with-expiry. One statement does all of it: insert a fresh
   * bucket, or add to a live one, or restart a window whose row has expired —
   * the CASE guard means an old row reused after its window rolled over starts
   * from zero rather than accumulating onto last window's count.
   */
  async increment(bucketId, amount, resetAtSec, nowSec) {
    await this._awaitReady();
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limit_buckets (bucket_id, count, reset_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (bucket_id) DO UPDATE SET
         count = CASE WHEN rate_limit_buckets.reset_at > $4
                      THEN rate_limit_buckets.count + $2
                      ELSE $2 END,
         reset_at = $3
       RETURNING count, reset_at`,
      [bucketId, amount, resetAtSec, nowSec],
    );
    return { count: Number(rows[0].count), resetAt: Number(rows[0].resetAt) };
  }

  /** Expired windows are dead weight; called opportunistically by the limiter. */
  async sweep(nowSec) {
    await this._awaitReady();
    // Defensive: also delete rows with NULL or non-finite reset_at
    await this.pool.query(
      'DELETE FROM rate_limit_buckets WHERE reset_at IS NULL OR reset_at <= $1',
      [nowSec],
    );
  }

  async close() {
    if (this._ownsPool) await this.pool.end();
  }
}

/**
 * Picks the store from the environment.
 *
 * RATE_LIMIT_STORE is deliberately absent by default: unset or 'memory' means
 * exactly today's behaviour, with nothing new to configure or run. Only an
 * explicit 'postgres' switches to the shared store.
 *
 * Returns null (meaning "caller should use MemoryStore") when postgres was
 * requested but no DATABASE_URL exists — that is a boot-time configuration
 * error and the caller should refuse to start rather than silently shard the
 * counters per process again.
 */
export function createRateLimitStore(env = process.env, opts = {}) {
  // Accept either the legacy numeric maxSize (memory-store sizing) or an
  // options object carrying a shared (Vault-managed) pool (#127).
  const { maxSize = 10000, pool } = typeof opts === 'number' ? { maxSize: opts } : opts;
  const kind = env.RATE_LIMIT_STORE || 'memory';
  if (kind === 'memory') return new MemoryStore(maxSize);
  if (kind === 'postgres') {
    if (!env.DATABASE_URL) {
      throw new Error(
        'RATE_LIMIT_STORE=postgres requires DATABASE_URL. ' +
          'Refusing to fall back to per-process memory: that would silently double every limit at 2 replicas.',
      );
    }
    // pool is a shared (Vault-managed) pool when #127 is configured; absent
    // means build one from the connection string as before.
    return new PostgresStore({ connectionString: env.DATABASE_URL, pool });
  }
  throw new Error(`Unknown RATE_LIMIT_STORE '${kind}' (expected 'memory' or 'postgres').`);
}
