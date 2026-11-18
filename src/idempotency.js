/**
 * Persistent idempotency keys for /settle.
 *
 * Settlement moves money; a retry after a timeout must replay the recorded
 * response rather than submit a second transaction. Keys live in Postgres with
 * a unique constraint, so two instances handling the same retry concurrently
 * still resolve to one settlement — the loser reads back the winner's response.
 *
 * When DATABASE_URL is unset the memory fallback keeps this a single-process
 * guarantee only, which is the same contract the rest of the in-memory state
 * already had. When Postgres fails at runtime the store degrades to that
 * memory fallback with a warning: rate limiting and cataloging keep working,
 * and settlement proceeds without cross-restart deduplication rather than
 * refusing to settle at all.
 *
 * Degradation is temporary (#729). A background probe retries the connection
 * (and the next begin() after the interval does too), so a transient
 * connection drop, query cancellation or failover does not downgrade the
 * process to process-local dedupe for the rest of its lifetime. When Postgres
 * answers again, records accumulated while degraded are written back and the
 * durable path resumes with a warning.
 */
import crypto from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';

/** How often a degraded store probes Postgres before restoring durable claims. */
const DEFAULT_RECOVERY_INTERVAL_MS = 10_000;

/** Process-lifetime store. The shape Postgres degrades into. */
export class MemoryIdempotencyStore {
  constructor() {
    this.records = new Map(); // key -> { statusCode, response }
  }

  /** Stable per-request key: client header when present, body hash otherwise. */
  keyFor(req) {
    const header = req.get('idempotency-key');
    if (header) return header.trim();
    return (
      'body:' +
      crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body ?? null))
        .digest('hex')
    );
  }

  /**
   * Claims `key`. Returns { key, replayed: false } if this call owns the
   * settlement, { replayed: true, statusCode, response } for a completed
   * duplicate, or { key, conflict: true } when another request is still in
   * flight — the caller answers that with 409 rather than a second settlement
   * or an unhelpful outcome-unknown 200 (#408).
   *
   * A claim left behind by a pre-submission failure is released with fail(),
   * so a retry can try again instead of queueing behind a dead claim forever.
   */
  async begin(key) {
    const existing = this.records.get(key);
    if (existing?.response) return { key, replayed: true, ...existing };
    if (existing?.pending) return { key, conflict: true };
    this.records.set(key, { pending: true });
    return { key, replayed: false };
  }

  async complete(key, statusCode, response) {
    this.records.set(key, { statusCode, response });
  }

  /** Releases an in-flight claim after a failure that did not submit. */
  async fail(key) {
    const existing = this.records.get(key);
    if (existing?.pending) this.records.delete(key);
  }
}

export class PostgresIdempotencyStore extends MemoryIdempotencyStore {
  /**
   * @param {string} databaseUrl - postgres:// connection string
   * @param {object} [options]
   * @param {object} [options.pool] - injected pg Pool (tests)
   * @param {Function} [options.warn] - warning sink
   * @param {number} [options.lockTimeoutMs] - how long to wait out a concurrent
   *   claim before degrading
   * @param {number} [options.recoveryIntervalMs] - how often to probe Postgres
   *   while degraded before restoring durable claims (0 probes on next begin)
   */
  constructor(
    databaseUrl,
    {
      pool,
      warn = msg => console.warn(msg),
      lockTimeoutMs = 5000,
      recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
    } = {},
  ) {
    super();
    this.warn = warn;
    this.pool = pool;
    this.degraded = false;
    this.lockTimeoutMs = lockTimeoutMs;
    this.recoveryIntervalMs = recoveryIntervalMs;
    this._recoveryTimer = null;
    this._recovering = false;
    this._nextProbeAt = 0;
    if (!this.pool) {
      import('pg')
        .then(({ default: pg }) => {
          this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
          this.pool.on('error', err => this._degrade(`Postgres error: ${err.message}`));
        })
        .catch(err => this._degrade(`pg unavailable (${err.message}); using in-memory keys`));
      // A pool that exists but cannot reach the database surfaces on first
      // query — handled by the degrade path inside begin().
    }
  }

  _degrade(message) {
    if (!this.degraded) {
      this.degraded = true;
      this._nextProbeAt = Date.now() + this.recoveryIntervalMs;
      this.warn(
        `[Idempotency] ${message} — idempotency is now process-local only; ` +
          'probing Postgres to restore durable claims',
      );
      this._startRecoveryProbe();
    }
  }

  /**
   * Restores the durable path once Postgres answers again (#729).
   *
   * A probe is a single `SELECT 1`. On success, records accumulated while
   * degraded are written back first, so a claim made during the outage is not
   * silently forgotten the moment the store looks healthy again. If either
   * step fails the store stays degraded and the probe is retried after the
   * interval; a pool error is not re-logged on every attempt.
   */
  async _recover() {
    if (!this.degraded) {
      this._stopRecoveryProbe();
      return false;
    }
    if (!this.pool || this._recovering) return false;

    this._recovering = true;
    try {
      await this.pool.query('SELECT 1');
      await this._flushDegradedRecords();
      this.degraded = false;
      this._stopRecoveryProbe();
      this.warn('[Idempotency] Postgres reachable again — durable idempotency resumed');
      return true;
    } catch {
      this._nextProbeAt = Date.now() + this.recoveryIntervalMs;
      return false;
    } finally {
      this._recovering = false;
    }
  }

  /**
   * Writes claims/responses made while degraded back to Postgres.
   *
   * Another replica may already hold the durable claim, so a completed
   * response only fills a row that is still pending; it never overwrites a
   * response another replica recorded. What this guarantees is that a claim
   * this process handed out locally becomes visible to the rest of the fleet
   * before the store reports itself healthy.
   */
  async _flushDegradedRecords() {
    // Drain until empty: a begin()/complete() can add a record while this loop
    // is awaiting Postgres, and a claim made during the outage must not be
    // forgotten when the store flips back to healthy.
    while (this.records.size > 0) {
      for (const [key, record] of [...this.records]) {
        if (record?.response) {
          await this.pool.query(
            'INSERT INTO idempotency_keys (key, status_code, response, completed_at) ' +
              'VALUES ($1, $2, $3, now()) ON CONFLICT (key) DO UPDATE ' +
              'SET status_code = EXCLUDED.status_code, response = EXCLUDED.response, ' +
              'completed_at = EXCLUDED.completed_at ' +
              'WHERE idempotency_keys.response IS NULL',
            [key, record.statusCode, JSON.stringify(record.response)],
          );
        } else if (record?.pending) {
          await this.pool.query(
            'INSERT INTO idempotency_keys (key) VALUES ($1) ON CONFLICT (key) DO NOTHING',
            [key],
          );
        }
        // Only drop the entry we actually wrote; a concurrent complete() may
        // have replaced it with a response that still needs backfilling.
        if (this.records.get(key) === record) this.records.delete(key);
      }
    }
  }

  _startRecoveryProbe() {
    if (this._recoveryTimer || this.recoveryIntervalMs <= 0) return;
    this._recoveryTimer = setInterval(() => {
      void this._recover();
    }, this.recoveryIntervalMs);
    // A probe must never be the reason a drained process stays alive.
    this._recoveryTimer.unref?.();
  }

  _stopRecoveryProbe() {
    if (!this._recoveryTimer) return;
    clearInterval(this._recoveryTimer);
    this._recoveryTimer = null;
  }

  /**
   * Serializable transaction: SELECT the recorded response; if absent, INSERT
   * a claim. The unique constraint on idempotency_keys.key makes the claim
   * atomic across instances — on conflict we poll briefly for the winner's
   * response before falling back.
   */
  async begin(key) {
    // While degraded, probe once per interval. This keeps recovery prompt
    // under traffic without paying a connection timeout on every settlement.
    if (this.degraded && this.pool && Date.now() >= this._nextProbeAt) {
      await this._recover();
    }
    if (this.degraded || !this.pool) return super.begin(key);
    const client = await this.pool.connect().catch(err => {
      this._degrade(`cannot connect: ${err.message}`);
      return null;
    });
    if (!client) return super.begin(key);

    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const existing = await client.query(
        'SELECT status_code, response FROM idempotency_keys WHERE key = $1',
        [key],
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        const row = existing.rows[0];
        return {
          key,
          replayed: true,
          statusCode: row.status_code,
          // node-postgres parses jsonb itself; tolerate text as well.
          response: typeof row.response === 'string' ? JSON.parse(row.response) : row.response,
        };
      }
      const inserted = await client.query(
        'INSERT INTO idempotency_keys (key) VALUES ($1) ON CONFLICT (key) DO NOTHING',
        [key],
      );
      await client.query('COMMIT');
      if (inserted.rowCount === 1) return { key, replayed: false };

      // Another instance claimed it concurrently. Wait briefly for its
      // response; if it is still in flight, report the conflict rather than
      // settling a second time (#408).
      const deadline = Date.now() + this.lockTimeoutMs;
      while (Date.now() < deadline) {
        const row = await this.pool.query(
          'SELECT status_code, response FROM idempotency_keys WHERE key = $1 AND response IS NOT NULL',
          [key],
        );
        if (row.rows.length > 0) {
          return {
            key,
            replayed: true,
            statusCode: row.rows[0].status_code,
            response:
              typeof row.rows[0].response === 'string'
                ? JSON.parse(row.rows[0].response)
                : row.rows[0].response,
          };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return { key, conflict: true };
    } catch (err) {
      this._degrade(`query failed: ${err.message}`);
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection may already be gone */
      }
      return super.begin(key);
    } finally {
      client.release();
    }
  }

  async complete(key, statusCode, response) {
    if (this.degraded || !this.pool) return super.complete(key, statusCode, response);
    try {
      await this.pool.query(
        'UPDATE idempotency_keys SET status_code = $2, response = $3, completed_at = now() WHERE key = $1',
        [key, statusCode, JSON.stringify(response)],
      );
    } catch (err) {
      this._degrade(`complete failed: ${err.message}`);
      await super.complete(key, statusCode, response);
    }
  }

  async fail(key) {
    if (this.degraded || !this.pool) return super.fail(key);
    try {
      await this.pool.query('DELETE FROM idempotency_keys WHERE key = $1 AND response IS NULL', [
        key,
      ]);
    } catch (err) {
      this._degrade(`fail failed: ${err.message}`);
      await super.fail(key);
    }
  }
}

/**
 * Builds the store from resolved config; null means no idempotency wiring.
 *
 * @param {object} config
 * @param {object} [options]
 * @param {object} [options.pool] - shared pg Pool to use (a Vault-managed pool,
 *   #127); absent means the store builds its own from databaseUrl
 */
export function buildIdempotencyStore(config, { pool } = {}) {
  if (config.databaseUrl) return new PostgresIdempotencyStore(config.databaseUrl, { pool });
  return new MemoryIdempotencyStore();
}
