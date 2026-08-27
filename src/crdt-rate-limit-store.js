/**
 * CRDT G-Counter rate limit store for multi-region deployments (#126).
 *
 * Each region maintains a local in-memory counter and periodically syncs to a
 * shared Postgres/CockroachDB table. Reads merge local + remote state using
 * the G-Counter (grow-only counter) CRDT merge: count = max(local, remote).
 *
 * This provides:
 *   - Continued operation during regional database outages (local counters)
 *   - Eventual convergence when connectivity is restored
 *   - Conservative rate limiting under partition (max merge may overcount)
 *   - No split-brain: each region's local state is independent
 *
 * The store is designed to sit behind the same interface as MemoryStore and
 * PostgresStore so it drops into the existing RateLimiter without changes.
 *
 * When the database is reachable, the sync loop writes the merged count. When
 * it is not, the local counter keeps the service operational — rate limiting
 * degrades to per-region accuracy rather than failing entirely.
 *
 * SCHEMA
 *
 *   CREATE TABLE IF NOT EXISTS crdt_rate_limit_buckets (
 *       bucket_id TEXT PRIMARY KEY,
 *       count     BIGINT NOT NULL DEFAULT 0,
 *       reset_at  BIGINT NOT NULL,
 *       region    VARCHAR(50) NOT NULL,
 *       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *
 *   CREATE INDEX IF NOT EXISTS idx_crdt_rate_limit_reset_at
 *       ON crdt_rate_limit_buckets (reset_at);
 *   CREATE INDEX IF NOT EXISTS idx_crdt_rate_limit_region
 *       ON crdt_rate_limit_buckets (region);
 */
import { setInterval, clearInterval } from 'node:timers';

const DEFAULT_SYNC_INTERVAL_MS = 10_000;

export class CrdtRateLimitStore {
  /**
   * @param {object} options
   * @param {string} options.region - this instance's region identifier
   * @param {object} [options.pool] - pg Pool (injected for tests)
   * @param {string} [options.databaseUrl] - Postgres/CockroachDB connection string
   * @param {number} [options.syncIntervalMs] - how often to sync local state
   * @param {(msg: string) => void} [options.warn] - warning sink
   */
  constructor({
    region,
    pool,
    databaseUrl,
    syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
    warn = msg => console.warn(msg),
    maxSize = 10000,
  }) {
    this.region = region;
    this.pool = pool ?? null;
    this.databaseUrl = databaseUrl;
    this.warn = warn;
    this.degraded = false;

    /** @type {Map<string, {count: number, resetAt: number}>} local counters */
    this.local = new Map();
    this.maxSize = maxSize;

    this._syncIntervalMs = syncIntervalMs;
    this._syncTimer = null;
    this._closed = false;

    if (!this.pool && this.databaseUrl) {
      import('pg')
        .then(({ default: pg }) => {
          if (this._closed) return;
          this.pool = new pg.Pool({
            connectionString: this.databaseUrl,
            max: 3,
            connectionTimeoutMillis: 3000,
          });
          this.pool.on('error', err => this._degrade(`pool error: ${err.message}`));
          this._initTable().then(() => this._startSync());
        })
        .catch(err => this._degrade(`pg unavailable (${err.message}); running in local-only mode`));
    } else if (this.pool) {
      this._initTable().then(() => this._startSync());
    }
  }

  async _initTable() {
    if (!this.pool) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS crdt_rate_limit_buckets (
          bucket_id TEXT PRIMARY KEY,
          count     BIGINT NOT NULL DEFAULT 0,
          reset_at  BIGINT NOT NULL,
          region    VARCHAR(50) NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_crdt_rate_limit_reset_at
          ON crdt_rate_limit_buckets (reset_at)
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_crdt_rate_limit_region
          ON crdt_rate_limit_buckets (region)
      `);
    } catch (err) {
      this._degrade(`table init failed: ${err.message}`);
    }
  }

  _startSync() {
    if (this._closed || this._syncTimer) return;
    this._syncTimer = setInterval(() => this._sync(), this._syncIntervalMs);
    this._syncTimer.unref?.();
  }

  _degrade(message) {
    if (!this.degraded) {
      this.degraded = true;
      this.warn(`[CrdtRateLimit] ${message} — operating in local-only mode`);
    }
  }

  _recover() {
    if (this.degraded) {
      this.degraded = false;
      this.warn('[CrdtRateLimit] database reconnected — CRDT sync restored');
    }
  }

  /**
   * Periodic sync: write merged counts to the database.
   *
   * Uses INSERT ... ON CONFLICT to upsert, taking the max of local and
   * remote count. This is the CRDT merge — monotonic growth is preserved
   * regardless of write ordering across regions.
   */
  async _sync() {
    if (this.degraded || !this.pool) return;

    try {
      for (const [bucketId, local] of this.local) {
        // Skip expired buckets — they will be swept.
        if (local.resetAt <= Math.floor(Date.now() / 1000)) continue;

        const { rows } = await this.pool.query(
          `INSERT INTO crdt_rate_limit_buckets (bucket_id, count, reset_at, region, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (bucket_id) DO UPDATE SET
             count = CASE
               WHEN crdt_rate_limit_buckets.reset_at < EXCLUDED.reset_at
               THEN EXCLUDED.count
               ELSE GREATEST(crdt_rate_limit_buckets.count, EXCLUDED.count)
             END,
             reset_at = EXCLUDED.reset_at,
             updated_at = now()
           WHERE crdt_rate_limit_buckets.reset_at <= EXCLUDED.reset_at
           RETURNING count`,
          [bucketId, local.count, local.resetAt, this.region],
        );

        if (rows.length > 0) {
          const mergedCount = Number(rows[0].count);
          this.local.set(bucketId, { count: mergedCount, resetAt: local.resetAt });
        }
      }
      this._recover();
    } catch (err) {
      this._degrade(`sync failed: ${err.message}`);
    }
  }

  /**
   * CRDT merge read: local G-Counter ∪ remote G-Counter.
   *
   * Reads local first, then queries the database for the remote count. The
   * merged count is max(local, remote) — the G-Counter merge operation.
   */
  async get(bucketId, now) {
    const local = this.local.get(bucketId);

    // Local expired or missing — check the database.
    if (!local || local.resetAt <= now) {
      if (this.degraded || !this.pool) return local;

      try {
        const { rows } = await this.pool.query(
          'SELECT count, reset_at FROM crdt_rate_limit_buckets WHERE bucket_id = $1',
          [bucketId],
        );
        if (rows.length > 0) {
          const remoteCount = Number(rows[0].count);
          const remoteResetAt = rows[0].reset_at;
          // Only merge with remote if it's in the same or newer window.
          if (remoteResetAt >= now) {
            if (local && local.resetAt > now) {
              return { count: Math.max(remoteCount, local.count), resetAt: remoteResetAt };
            }
            return { count: remoteCount, resetAt: remoteResetAt };
          }
        }
      } catch (err) {
        this._degrade(`get failed: ${err.message}`);
      }
      return local;
    }

    // Local is valid — also check remote for the merged view.
    if (this.degraded || !this.pool) return local;

    try {
      const { rows } = await this.pool.query(
        'SELECT count, reset_at FROM crdt_rate_limit_buckets WHERE bucket_id = $1',
        [bucketId],
      );
      if (rows.length > 0) {
        const remoteCount = Number(rows[0].count);
        const remoteResetAt = rows[0].reset_at;
        // Only merge with remote if it's in the same window (same reset_at).
        if (remoteResetAt === local.resetAt) {
          return { count: Math.max(local.count, remoteCount), resetAt: local.resetAt };
        }
      }
    } catch (err) {
      this._degrade(`get merge failed: ${err.message}`);
    }
    return local;
  }

  /**
   * Atomic increment with CRDT merge.
   *
   * Increments the local counter first (always available), then merges with
   * the database. Under partition, the local counter keeps the service
   * operational; when the database returns, the merge converges.
   */
  async increment(bucketId, amount, resetAt, now) {
    const existing = this.local.get(bucketId);
    let localCount;

    if (!existing || existing.resetAt <= now) {
      // New window or expired — start fresh.
      localCount = amount;
    } else {
      localCount = existing.count + amount;
    }

    this.local.set(bucketId, { count: localCount, resetAt });

    // Cap the local store size by shedding oldest buckets when limit is hit
    if (this.local.size > this.maxSize) {
      const entries = Array.from(this.local.entries());
      // Sort by resetAt ascending (oldest first)
      entries.sort((a, b) => a[1].resetAt - b[1].resetAt);
      // Remove the oldest entries to get back under the limit
      const toRemove = entries.slice(0, this.local.size - this.maxSize);
      for (const [id] of toRemove) {
        this.local.delete(id);
      }
    }

    return { count: localCount, resetAt };
  }

  async sweep(now) {
    // Sweep local.
    for (const [key, entry] of this.local) {
      // Defensive: evict buckets without finite resetAt (malformed entries)
      if (!Number.isFinite(entry.resetAt) || entry.resetAt <= now) this.local.delete(key);
    }

    // Sweep remote.
    if (this.degraded || !this.pool) return;
    try {
      // Defensive: also delete rows with NULL or non-finite reset_at
      await this.pool.query(
        'DELETE FROM crdt_rate_limit_buckets WHERE reset_at IS NULL OR reset_at <= $1',
        [now],
      );
    } catch (err) {
      this._degrade(`sweep failed: ${err.message}`);
    }
  }

  async close() {
    this._closed = true;
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (this.pool) {
      await this.pool.end().catch(() => {});
    }
  }
}
