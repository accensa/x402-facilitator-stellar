import { MemorySettlementStore } from './memory.js';

export class PostgresSettlementStore extends MemorySettlementStore {
  /**
   * @param {string} databaseUrl - postgres connection string
   * @param {object} [options]
   * @param {object} [options.pool] - injected pg Pool (for testing)
   * @param {Function} [options.warn] - logger sink
   */
  constructor(databaseUrl, { pool, warn = msg => console.warn(msg) } = {}) {
    super();
    this.warn = warn;
    this.pool = pool;
    this.degraded = false;

    if (!this.pool) {
      import('pg')
        .then(({ default: pg }) => {
          this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
          this.pool.on('error', err => this._degrade(`Postgres error: ${err.message}`));
          this.ready = this._ensureTable();
        })
        .catch(err => this._degrade(`pg unavailable (${err.message}); using memory settlement store`));
    } else {
      this.ready = this._ensureTable();
    }
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

  async get(idempotencyKey) {
    if (this.degraded || !this.pool) return super.get(idempotencyKey);
    try {
      await this.ready;
      const { rows } = await this.pool.query(
        'SELECT idempotency_key, network, scheme, payer, pay_to, asset, amount, state, tx_hash, error_reason, error_message, response, key_id, created_at, updated_at FROM settlements WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      if (rows.length === 0) return null;
      const r = rows[0];
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
    } catch (err) {
      this._degrade(`get failed: ${err.message}`);
      return super.get(idempotencyKey);
    }
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
      const r = rows[0];
      const entry = {
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
      const r = rows[0];
      const entry = {
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
        key_id: r.key_id,
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      };
      await super.updateState(idempotencyKey, state, details);
      return entry;
    } catch (err) {
      this._degrade(`updateState failed: ${err.message}`);
      return super.updateState(idempotencyKey, state, details);
    }
  }

  async listUnknown() {
    if (this.degraded || !this.pool) return super.listUnknown();
    try {
      await this.ready;
      const { rows } = await this.pool.query(
        'SELECT idempotency_key, network, scheme, payer, pay_to, asset, amount, state, tx_hash, error_reason, error_message, key_id, created_at, updated_at FROM settlements WHERE state = $1',
        ['unknown'],
      );
      return rows.map(r => ({
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
        key_id: r.key_id,
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      }));
    } catch (err) {
      this._degrade(`listUnknown failed: ${err.message}`);
      return super.listUnknown();
    }
  }
}
