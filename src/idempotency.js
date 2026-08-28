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
 */
import crypto from 'node:crypto';

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
   * settlement, or { replayed: true, statusCode, response } for a duplicate.
   * A claim left uncompleted (the settlement threw) is re-claimable: retries
   * must be able to try again after a failure.
   */
  async begin(key) {
    const existing = this.records.get(key);
    if (existing?.response) return { key, replayed: true, ...existing };
    this.records.set(key, { pending: true });
    return { key, replayed: false };
  }

  async complete(key, statusCode, response) {
    this.records.set(key, { statusCode, response });
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
   */
  constructor(databaseUrl, { pool, warn = msg => console.warn(msg), lockTimeoutMs = 5000 } = {}) {
    super();
    this.warn = warn;
    this.pool = pool;
    this.degraded = false;
    this.lockTimeoutMs = lockTimeoutMs;
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
      this.warn(`[Idempotency] ${message} — idempotency is now process-local only`);
    }
  }

  /**
   * Serializable transaction: SELECT the recorded response; if absent, INSERT
   * a claim. The unique constraint on idempotency_keys.key makes the claim
   * atomic across instances — on conflict we poll briefly for the winner's
   * response before falling back.
   */
  async begin(key) {
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

      // Another instance claimed it concurrently. Wait for its response.
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
      this._degrade(`concurrent claim for ${key} never completed`);
      return super.begin(key);
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
