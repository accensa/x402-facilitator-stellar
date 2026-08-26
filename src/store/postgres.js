import crypto from 'node:crypto';
import { OutboxStore } from '../outbox/store.js';
import { MemorySettlementStore } from './memory.js';

export class PostgresSettlementStore extends MemorySettlementStore {
  /**
   * @param {string} databaseUrl - postgres connection string
   * @param {object} [options]
   * @param {object} [options.pool] - injected pg Pool (for testing)
   * @param {Function} [options.warn] - logger sink
   * @param {object} [options.outbox] - OutboxStore sharing this pool (default:
   *   created lazily from the pool; the transactional outbox is how settlement
   *   notifications survive crashes, #123)
   */
  constructor(databaseUrl, { pool, warn = msg => console.warn(msg), outbox } = {}) {
    super();
    this.warn = warn;
    this.pool = pool;
    this.degraded = false;
    this.outbox = outbox ?? null;

    if (!this.pool) {
      import('pg')
        .then(({ default: pg }) => {
          this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
          this.pool.on('error', err => this._degrade(`Postgres error: ${err.message}`));
          this.outbox ??= new OutboxStore(this.pool, { warn: this.warn });
          this.ready = this._ensureTable();
        })
        .catch(err =>
          this._degrade(`pg unavailable (${err.message}); using memory settlement store`),
        );
    } else {
      this.outbox ??= new OutboxStore(this.pool, { warn: this.warn });
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
      // The outbox table is created with the settlement schema so the atomic
      // settle+enqueue transaction never finds its table missing (#123).
      await this.outbox?.ready;
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

  /**
   * Settlement state change + notification enqueue in ONE transaction (#123).
   *
   * The guarantee the issue asks for: if the process crashes after settlement
   * but before the notification reaches the broker, the notification must not
   * be lost. Both the `settled` state change and the `outbox_events` insert
   * commit atomically here, so the background worker (src/outbox/) can
   * publish it afterwards — a crash at any point leaves the event either
   * uncommitted (nothing settled, nothing to notify) or pending in the
   * outbox (publishable later).
   *
   * Returns `atomicallyEnqueued: false` when there is no usable Postgres (no
   * pool or degraded) — the caller then falls back to the direct webhook
   * publish, which is the pre-outbox behaviour.
   *
   * @param {string} idempotencyKey
   * @param {object} details - updateState details (tx_hash, response, ...)
   * @param {object|null} event - notification event; null = state change only
   * @param {object} [opts]
   * @param {string} [opts.eventId] - caller-chosen idempotency key for the event
   * @returns {Promise<{atomicallyEnqueued: boolean, record: object|null, event: object|null}>}
   */
  async settleAndEnqueue(idempotencyKey, details, event, { eventId } = {}) {
    if (this.degraded || !this.pool) {
      const record = await super.updateState(idempotencyKey, 'settled', details);
      return { atomicallyEnqueued: false, record, event };
    }
    try {
      await this.ready;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `UPDATE settlements SET
            state = 'settled',
            tx_hash = COALESCE($2, tx_hash),
            error_reason = COALESCE($3, error_reason),
            error_message = COALESCE($4, error_message),
            response = COALESCE($5, response),
            updated_at = NOW()
          WHERE idempotency_key = $1
          RETURNING idempotency_key, network, scheme, payer, pay_to, asset, amount, state, tx_hash, error_reason, error_message, response, key_id, created_at, updated_at`,
          [
            idempotencyKey,
            details.tx_hash ?? null,
            details.error_reason ?? null,
            details.error_message ?? null,
            details.response ? JSON.stringify(details.response) : null,
          ],
        );

        const resolvedEvent =
          event == null ? null : { ...event, id: eventId ?? event.id ?? crypto.randomUUID() };
        if (rows.length > 0 && resolvedEvent) {
          await this.outbox.insertEvent(client, {
            eventId: resolvedEvent.id,
            type: resolvedEvent.type,
            payload: resolvedEvent,
          });
        }
        await client.query('COMMIT');

        let entry = null;
        if (rows.length > 0) {
          const r = rows[0];
          entry = {
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
          await super.updateState(idempotencyKey, 'settled', details);
        }
        return { atomicallyEnqueued: true, record: entry, event: resolvedEvent };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      this._degrade(`settleAndEnqueue failed: ${err.message}`);
      const record = await super.updateState(idempotencyKey, 'settled', details);
      return { atomicallyEnqueued: false, record, event };
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
