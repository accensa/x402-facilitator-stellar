import { MemorySettlementStore } from './memory.js';

/**
 * Postgres-backed settlement store with CQRS read/write split (#121).
 *
 * Writes (`save`, `updateState`) always go to the primary pool.
 * Reads (`get`, `listUnknown`) route to the read-replica pool when one is
 * configured, keeping historical status queries off the primary event loop so
 * settlement submissions never contend with scan traffic.
 *
 * Read-after-write consistency (#121): Postgres streaming replication is
 * asynchronous, so a settlement written to the primary can be momentarily
 * invisible to a replica. We never re-read the very row we just wrote from a
 * replica: every handler that writes also caches the canonical record into the
 * in-memory fallback (`super`), and a replica read that cannot yet see a row
 * requests the caller retry for up to `replicaLagMs`, then re-checks the
 * primary before declaring it missing. That bounds the staleness window to
 * (at most) one network round-trip against the primary — the compound copy
 * converges once replication drains.
 */
export class PostgresSettlementStore extends MemorySettlementStore {
  /**
   * @param {string} databaseUrl - primary postgres connection string
   * @param {object} [options]
   * @param {string} [options.replicaUrl] - read-replica postgres connection string (#121)
   * @param {object} [options.pool] - injected primary pg Pool (for testing)
   * @param {object} [options.replicaPool] - injected replica pg Pool (for testing)
   * @param {number} [options.replicaLagMs] - max acceptable replica lag (ms) before
   *   falling back to the primary for a missing row (#121)
   * @param {Function} [options.warn] - logger sink
   */
  constructor(
    databaseUrl,
    { pool, replicaPool, replicaUrl, replicaLagMs = 1000, warn = msg => console.warn(msg) } = {},
  ) {
    super();
    this.warn = warn;
    this.pool = pool; // primary (writes + fallback reads)
    this.replicaPool = replicaPool; // read replica (reads)
    this.replicaLagMs = replicaLagMs;
    this.degraded = false;
    this._readyReplica = false;

    if (this.pool) {
      this.ready = this._ensureTable();
      this._readyReplica = Promise.resolve();
    } else {
      import('pg')
        .then(({ default: pg }) => {
          this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
          this.pool.on('error', err => this._degrade(`Postgres error: ${err.message}`));
          this.ready = this._ensureTable();
        })
        .catch(err =>
          this._degrade(`pg unavailable (${err.message}); using memory settlement store`),
        );
    }

    // A replica is optional. When one is configured we lazy-init its pool and
    // surface a `ready` promise the caller can await before routing reads.
    if (replicaPool) {
      this.replicaPool = replicaPool;
      this._readyReplica = Promise.resolve();
    } else if (replicaUrl) {
      import('pg')
        .then(({ default: pg }) => {
          this.replicaPool = new pg.Pool({ connectionString: replicaUrl, max: 20 });
          this.replicaPool.on('error', err =>
            this.warn(`[SettlementStore] replica pool error: ${err.message}`),
          );
          this._readyReplica = Promise.resolve();
        })
        .catch(err => this.warn(`[SettlementStore] pg unavailable for replica (${err.message})`));
    } else {
      this._readyReplica = Promise.resolve();
    }
  }

  /** True when reads should target the replica (a replica is wired up). */
  get usesReplica() {
    return Boolean(this.replicaPool) && !this.degraded;
  }

  _degrade(message) {
    if (!this.degraded) {
      this.degraded = true;
      this.warn(`[SettlementStore] ${message} — settlement store degraded to process-local memory`);
    }
  }

  async _ensureTable() {
    if (!this.pool || this.degraded) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS settlements (
            idempotency_key TEXT PRIMARY KEY,
            network TEXT NOT NULL,
            scheme TEXT NOT NULL,
            payer TEXT,
            pay_to TEXT,
            asset TEXT,
            amount TEXT,
            state TEXT NOT NULL CHECK (state IN ('submitted', 'settled', 'failed', 'unknown')),
            tx_hash TEXT,
            error_reason TEXT,
            error_message TEXT,
            response JSONB,
            key_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_settlements_key_id ON settlements(key_id);
        CREATE INDEX IF NOT EXISTS idx_settlements_state ON settlements(state);
      `);
    } catch (err) {
      this._degrade(`failed to create table: ${err.message}`);
    }
  }

  /** @returns {object} the live read pool (replica when CQRS is configured). */
  _readPool() {
    return this.usesReplica ? this.replicaPool : this.pool;
  }

  async get(idempotencyKey) {
    // The in-memory copy is kept in sync by every successful write (see the
    // `super.*` calls below) and double-checks the very rows this process wrote.
    // A replica read of our own just-submitted write could otherwise lag.
    const local = await super.get(idempotencyKey);
    if (local) return local;

    if (this.degraded || !this.pool) return null;
    try {
      await this.ready;
      return await this._queryGet(this._readPool(), idempotencyKey);
    } catch (err) {
      this._degrade(`get failed: ${err.message}`);
      return super.get(idempotencyKey);
    }
  }

  /**
   * Performs a single get against the given pool, returning the row or null.
   */
  async _queryGet(pool, idempotencyKey) {
    const { rows } = await pool.query(
      'SELECT idempotency_key, network, scheme, payer, pay_to, asset, amount, state, tx_hash, error_reason, error_message, response, key_id, created_at, updated_at FROM settlements WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    if (rows.length === 0) return null;
    return this._toRecord(rows[0]);
  }

  /**
   * Read with a replica-lag tolerance (#121): when a replica is configured,
   * a row that the replica hasn't propagated yet is retried until `replicaLagMs`
   * elapses, then checked against the primary so a genuine miss is still a miss
   * and a recent write is surfaced. This is what makes "settle, then immediately
   * GET" consistent despite asynchronous replication.
   */
  async _queryGetWithLag(idempotencyKey) {
    if (!this.usesReplica) return this._queryGet(this.pool, idempotencyKey);

    const started = Date.now();
    for (;;) {
      const row = await this._queryGet(this.replicaPool, idempotencyKey);
      if (row) return row;
      if (Date.now() - started >= this.replicaLagMs) break;
      await new Promise(r => setTimeout(r, 25));
    }
    // Replica still can't see it. Assume recent write / replication drain and
    // confirm against the primary before returning a genuine miss.
    return this._queryGet(this.pool, idempotencyKey);
  }

  _toRecord(r) {
    return {
      idempotency_key: r.idempotency_key,
      network: r.network,
      scheme: r.scheme,
      payer: r.payer,
      pay_to: r.pay_to,
      asset: r.asset,
      amount: r.amount,
      state: r.state,
      tx_hash: r.tx_hash,
      error_reason: r.error_reason,
      error_message: r.error_message,
      response: r.response,
      key_id: r.key_id,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async save(record) {
    if (this.degraded || !this.pool) return super.save(record);
    try {
      await this.ready;
      const { rows } = await this.pool.query(
        `INSERT INTO settlements (
          idempotency_key, network, scheme, payer, pay_to, asset, amount, state, tx_hash, error_reason, error_message, response, key_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
        ON CONFLICT (idempotency_key) DO UPDATE SET
          state = EXCLUDED.state,
          tx_hash = COALESCE(EXCLUDED.tx_hash, settlements.tx_hash),
          error_reason = COALESCE(EXCLUDED.error_reason, settlements.error_reason),
          error_message = COALESCE(EXCLUDED.error_message, settlements.error_message),
          response = COALESCE(EXCLUDED.response, settlements.response),
          updated_at = NOW()
        RETURNING idempotency_key, network, scheme, payer, pay_to, asset, amount, state, tx_hash, error_reason, error_message, response, key_id, created_at, updated_at`,
        [
          record.idempotency_key,
          record.network ?? '',
          record.scheme ?? '',
          record.payer ?? null,
          record.pay_to ?? null,
          record.asset ?? null,
          record.amount ?? null,
          record.state ?? 'submitted',
          record.tx_hash ?? null,
          record.error_reason ?? null,
          record.error_message ?? null,
          record.response ? JSON.stringify(record.response) : null,
          record.key_id ?? null,
        ],
      );
      const entry = this._toRecord(rows[0]);
      await super.save(entry);
      return entry;
    } catch (err) {
      this._degrade(`save failed: ${err.message}`);
      return super.save(record);
    }
  }

  async updateState(idempotencyKey, state, details = {}) {
    if (this.degraded || !this.pool) return super.updateState(idempotencyKey, state, details);
    try {
      await this.ready;
      const { rows } = await this.pool.query(
        `UPDATE settlements SET
          state = $2,
          tx_hash = COALESCE($3, tx_hash),
          error_reason = COALESCE($4, error_reason),
          error_message = COALESCE($5, error_message),
          response = COALESCE($6, response),
          updated_at = NOW()
        WHERE idempotency_key = $1
        RETURNING idempotency_key, network, scheme, payer, pay_to, asset, amount, state, tx_hash, error_reason, error_message, response, key_id, created_at, updated_at`,
        [
          idempotencyKey,
          state,
          details.tx_hash ?? null,
          details.error_reason ?? null,
          details.error_message ?? null,
          details.response ? JSON.stringify(details.response) : null,
        ],
      );
      if (rows.length === 0) return null;
      const entry = this._toRecord(rows[0]);
      await super.updateState(idempotencyKey, state, details);
      return entry;
    } catch (err) {
      this._degrade(`updateState failed: ${err.message}`);
      return super.updateState(idempotencyKey, state, details);
    }
  }

  /**
   * Read-after-write-consistent GET (#121): the settlement-status route uses
   * this instead of `get()` so a client can settle and immediately read back
   * the recorded status even while the replica is draining. Local writes are
   * served from memory; anything else tolerates replica lag up to
   * `replicaLagMs` before confirming against the primary.
   */
  async getConsistent(idempotencyKey) {
    const local = await super.get(idempotencyKey);
    if (local) return local;
    if (this.degraded || !this.pool) return null;
    try {
      await this.ready;
      await this._readyReplica;
      return await this._queryGetWithLag(idempotencyKey);
    } catch (err) {
      this._degrade(`getConsistent failed: ${err.message}`);
      return super.get(idempotencyKey);
    }
  }

  async listUnknown() {
    // The reconciliation sweep is a read of historical state — route it to the
    // replica too. Replayed writes are applied to the primary, so listing
    // unknown records from a replica is safe: any row the replica sees is either
    // already resolved on the primary or legitimately still unknown.
    const pool = this._readPool();
    if (this.degraded || !pool) return super.listUnknown();
    try {
      await this.ready;
      const { rows } = await pool.query(
        'SELECT idempotency_key, network, scheme, payer, pay_to, asset, amount, state, tx_hash, error_reason, error_message, key_id, created_at, updated_at FROM settlements WHERE state = $1',
        ['unknown'],
      );
      return rows.map(r => this._toRecord(r));
    } catch (err) {
      this._degrade(`listUnknown failed: ${err.message}`);
      return super.listUnknown();
    }
  }
}
