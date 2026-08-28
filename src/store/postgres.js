import crypto from 'node:crypto';
import { OutboxStore } from '../outbox/store.js';
import { MemorySettlementStore } from './memory.js';
import { eventTypeForState } from '../eventstore/events.js';
import { projectSettlement } from '../eventstore/projection.js';

const PROJECTION_COLUMN_NAMES = [
  'idempotency_key',
  'network',
  'scheme',
  'payer',
  'pay_to',
  'asset',
  'amount',
  'state',
  'tx_hash',
  'error_reason',
  'error_message',
  'response',
  'key_id',
  'version',
  'created_at',
  'updated_at',
];
const PROJECTION_COLUMNS = PROJECTION_COLUMN_NAMES.join(', ');
const QUALIFIED_PROJECTION_COLUMNS = PROJECTION_COLUMN_NAMES.map(
  c => `settlement_projections.${c}`,
).join(', ');

function mapProjectionRow(r) {
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
    version: r.version,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

function mapEventRow(r) {
  return {
    idempotency_key: r.idempotency_key,
    seq: r.seq,
    event_type: r.event_type,
    event_version: r.event_version,
    payload: r.payload,
    recorded_at: new Date(r.recorded_at).toISOString(),
  };
}

/**
 * Postgres-backed, event-sourced settlement store (#10, #130).
 *
 * `settlement_events` is the append-only source of truth; `settlement_projections`
 * is a read model, derived and never written to except as the same statement
 * that appends the event which produced it. Every write below is one round
 * trip: a CTE inserts the event, then upserts the projection from it, so the
 * two can never observably disagree — there is no window where an event
 * exists without its projection, or vice versa.
 *
 * Reads never replay the log — they hit `settlement_projections` directly, an
 * index-backed table. `rebuildProjection` is the deliberately-separate slow
 * path that replays a stream through the same fold `MemorySettlementStore`
 * uses, for repair or verification.
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
   * @param {object} [options.outbox] - OutboxStore sharing this pool (default:
   *   created lazily from the pool; the transactional outbox is how settlement
   *   notifications survive crashes, #123)
   */
  constructor(
    databaseUrl,
    {
      pool,
      replicaPool,
      replicaUrl,
      replicaLagMs = 1000,
      warn = msg => console.warn(msg),
      outbox,
    } = {},
  ) {
    super();
    this.warn = warn;
    this.pool = pool ?? null; // primary (writes + fallback reads)
    this.replicaPool = replicaPool ?? null; // read replica (reads)
    this.replicaUrl = replicaUrl ?? null; // read-replica connection string (#121)
    this.replicaLagMs = replicaLagMs;
    this.degraded = false;
    this.outbox = outbox ?? null;
    this.ready = null;
    this._readyReplica = Promise.resolve();

    // Primary pool: use an injected one when provided, otherwise build it
    // lazily from the connection string. When neither is available the store
    // degrades to process-local memory (see _degrade).
    if (this.pool) {
      // The transactional outbox shares the primary pool (created here when
      // not injected) so settleAndEnqueue's state change + notification
      // insert commit atomically (#123).
      this.outbox ??= new OutboxStore(this.pool, { warn: this.warn });
      this.ready = this._ensureSchema();
    } else {
      import('pg')
        .then(({ default: pg }) => {
          this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
          this.pool.on('error', err => this._degrade(`Postgres error: ${err.message}`));
          this.outbox ??= new OutboxStore(this.pool, { warn: this.warn });
          this.ready = this._ensureSchema();
        })
        .catch(err =>
          this._degrade(`pg unavailable (${err.message}); using memory settlement store`),
        );
    }

    // A read replica is optional. An injected pool is ready immediately; a
    // connection string is turned into a pool lazily. When neither is given,
    // `usesReplica` stays false and all reads go to the primary — the
    // pre-#121 single-pool behaviour, and the zero-config default.
    if (this.replicaPool) {
      this._readyReplica = Promise.resolve();
    } else if (this.replicaUrl) {
      this._readyReplica = import('pg').then(({ default: pg }) => {
        this.replicaPool = new pg.Pool({ connectionString: this.replicaUrl, max: 20 });
        this.replicaPool.on('error', err =>
          this.warn(`[SettlementStore] replica pool error: ${err.message}`),
        );
      });
      this._readyReplica.catch(err =>
        this.warn(`[SettlementStore] pg unavailable for replica (${err.message})`),
      );
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

  async _ensureSchema() {
    if (!this.pool || this.degraded) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS settlement_events (
            id BIGSERIAL PRIMARY KEY,
            idempotency_key TEXT NOT NULL,
            seq INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            event_version INTEGER NOT NULL DEFAULT 1,
            payload JSONB NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (idempotency_key, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_settlement_events_key ON settlement_events(idempotency_key, seq);
        CREATE INDEX IF NOT EXISTS idx_settlement_events_recorded_at ON settlement_events(recorded_at);

        CREATE TABLE IF NOT EXISTS settlement_projections (
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
            version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_settlement_projections_key_id ON settlement_projections(key_id);
        CREATE INDEX IF NOT EXISTS idx_settlement_projections_state ON settlement_projections(state);
      `);
      // The outbox table is created with the settlement schema so the atomic
      // settle+enqueue transaction never finds its table missing (#123).
      await this.outbox?.ready;
    } catch (err) {
      this._degrade(`failed to create schema: ${err.message}`);
    }
  }

  /** @returns {object} the live read pool (replica when CQRS is configured). */
  _readPool() {
    return this.usesReplica ? this.replicaPool : this.pool;
  }

  async get(idempotencyKey) {
    // Platform read: always hit the database (the read pool when a replica is
    // configured). Read-after-write for the status endpoint is served by
    // `getConsistent`, which layers this process's own-writes-from-memory on
    // top — plain `get` must reflect durable state, so the #130 repair path
    // (delete the projection, rebuild it from the event log) stays observable.
    if (this.degraded || !this.pool) return super.get(idempotencyKey);
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
      `SELECT ${PROJECTION_COLUMNS} FROM settlement_projections WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (rows.length === 0) return null;
    return mapProjectionRow(rows[0]);
  }

  /**
   * Consistency-aware status read (#121): serves "settle, then immediately
   * GET" correctly under asynchronous replication.
   *
   * Layers, in order:
   *   1. This process's own writes, kept in the in-memory copy by every
   *      successful write, always served immediately (a replica read never
   *      touches our own fresh write).
   *   2. The replica, retried up to `replicaLagMs` for a row that hasn't
   *      propagated yet.
   *   3. The primary, so a genuine miss is still a miss and a recent write by
   *      another pod is surfaced — a 404 is only returned once replication is
   *      confirmed to have drained.
   *
   * This is the read `/settlements/:key` uses (see app.js).
   */
  async getConsistent(idempotencyKey) {
    const local = await super.get(idempotencyKey);
    if (local) return local;

    if (this.degraded || !this.pool) return this.get(idempotencyKey);
    try {
      await this.ready;
      await this._readyReplica;
      return await this._queryGetWithLag(idempotencyKey);
    } catch (err) {
      this._degrade(`getConsistent failed: ${err.message}`);
      return this.get(idempotencyKey);
    }
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

  async save(record) {
    if (this.degraded || !this.pool) return super.save(record);
    try {
      await this.ready;
      const { rows } = await this.pool.query(
        `WITH next_seq AS (
          SELECT COALESCE(MAX(seq), 0) + 1 AS seq
          FROM settlement_events WHERE idempotency_key = $1
        ),
        ins_event AS (
          INSERT INTO settlement_events (idempotency_key, seq, event_type, event_version, payload, recorded_at)
          SELECT $1, next_seq.seq, 'SettlementInitiated', 1, $2::jsonb, NOW()
          FROM next_seq
          RETURNING idempotency_key, seq, recorded_at
        )
        INSERT INTO settlement_projections (
          idempotency_key, network, scheme, payer, pay_to, asset, amount, state,
          tx_hash, error_reason, error_message, response, key_id, version, created_at, updated_at
        )
        SELECT
          ins_event.idempotency_key, $3, $4, $5, $6, $7, $8, 'submitted',
          $9, NULL, NULL, NULL, $10, ins_event.seq, ins_event.recorded_at, ins_event.recorded_at
        FROM ins_event
        ON CONFLICT (idempotency_key) DO UPDATE SET
          network = EXCLUDED.network,
          scheme = EXCLUDED.scheme,
          payer = EXCLUDED.payer,
          pay_to = EXCLUDED.pay_to,
          asset = EXCLUDED.asset,
          amount = EXCLUDED.amount,
          state = 'submitted',
          tx_hash = EXCLUDED.tx_hash,
          error_reason = NULL,
          error_message = NULL,
          response = NULL,
          key_id = EXCLUDED.key_id,
          version = EXCLUDED.version,
          updated_at = EXCLUDED.updated_at
        RETURNING ${PROJECTION_COLUMNS}`,
        [
          record.idempotency_key,
          JSON.stringify({
            idempotency_key: record.idempotency_key,
            network: record.network ?? '',
            scheme: record.scheme ?? '',
            payer: record.payer ?? null,
            pay_to: record.pay_to ?? null,
            asset: record.asset ?? null,
            amount: record.amount ?? null,
            tx_hash: record.tx_hash ?? null,
            key_id: record.key_id ?? null,
          }),
          record.network ?? '',
          record.scheme ?? '',
          record.payer ?? null,
          record.pay_to ?? null,
          record.asset ?? null,
          record.amount ?? null,
          record.tx_hash ?? null,
          record.key_id ?? null,
        ],
      );
      const entry = mapProjectionRow(rows[0]);
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
      const eventType = eventTypeForState(state);
      const { rows } = await this.pool.query(
        `WITH next_seq AS (
          SELECT COALESCE(MAX(seq), 0) + 1 AS seq
          FROM settlement_events WHERE idempotency_key = $1
        ),
        ins_event AS (
          INSERT INTO settlement_events (idempotency_key, seq, event_type, event_version, payload, recorded_at)
          SELECT $1, next_seq.seq, $2, 1, $3::jsonb, NOW()
          FROM next_seq
          WHERE EXISTS (SELECT 1 FROM settlement_projections WHERE idempotency_key = $1)
          RETURNING idempotency_key, seq, recorded_at
        )
        UPDATE settlement_projections SET
          state = $4,
          tx_hash = COALESCE($5, settlement_projections.tx_hash),
          error_reason = COALESCE($6, settlement_projections.error_reason),
          error_message = COALESCE($7, settlement_projections.error_message),
          response = COALESCE($8, settlement_projections.response),
          version = ins_event.seq,
          updated_at = ins_event.recorded_at
        FROM ins_event
        WHERE settlement_projections.idempotency_key = ins_event.idempotency_key
        RETURNING ${QUALIFIED_PROJECTION_COLUMNS}`,
        [
          idempotencyKey,
          eventType,
          JSON.stringify({
            idempotency_key: idempotencyKey,
            tx_hash: details.tx_hash ?? null,
            error_reason: details.error_reason ?? null,
            error_message: details.error_message ?? null,
            response: details.response ?? null,
          }),
          state,
          details.tx_hash ?? null,
          details.error_reason ?? null,
          details.error_message ?? null,
          details.response ? JSON.stringify(details.response) : null,
        ],
      );
      if (rows.length === 0) return null;
      const entry = mapProjectionRow(rows[0]);
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
        // The same event-then-projection write as updateState(), folded into
        // the outbox transaction: append SettlementSettled to the event log
        // and update the read model in one statement, then insert the
        // notification row — all atomic, so a crash between settling and
        // notifying can never lose the notification (#123, #130).
        const eventType = eventTypeForState('settled');
        const { rows } = await client.query(
          `WITH next_seq AS (
            SELECT COALESCE(MAX(seq), 0) + 1 AS seq
            FROM settlement_events WHERE idempotency_key = $1
          ),
          ins_event AS (
            INSERT INTO settlement_events (idempotency_key, seq, event_type, event_version, payload, recorded_at)
            SELECT $1, next_seq.seq, $2, 1, $3::jsonb, NOW()
            FROM next_seq
            WHERE EXISTS (SELECT 1 FROM settlement_projections WHERE idempotency_key = $1)
            RETURNING idempotency_key, seq, recorded_at
          )
          UPDATE settlement_projections SET
            state = $4,
            tx_hash = COALESCE($5, settlement_projections.tx_hash),
            error_reason = COALESCE($6, settlement_projections.error_reason),
            error_message = COALESCE($7, settlement_projections.error_message),
            response = COALESCE($8, settlement_projections.response),
            version = ins_event.seq,
            updated_at = ins_event.recorded_at
          FROM ins_event
          WHERE settlement_projections.idempotency_key = ins_event.idempotency_key
          RETURNING ${QUALIFIED_PROJECTION_COLUMNS}`,
          [
            idempotencyKey,
            eventType,
            JSON.stringify({
              idempotency_key: idempotencyKey,
              tx_hash: details.tx_hash ?? null,
              error_reason: details.error_reason ?? null,
              error_message: details.error_message ?? null,
              response: details.response ?? null,
            }),
            'settled',
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
          entry = mapProjectionRow(rows[0]);
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
    // The reconciliation sweep is a read of historical state — route it to the
    // replica too. Replayed writes are applied to the primary, so listing
    // unknown records from a replica is safe: any row the replica sees is either
    // already resolved on the primary or legitimately still unknown.
    const pool = this._readPool();
    if (this.degraded || !pool) return super.listUnknown();
    try {
      await this.ready;
      const { rows } = await pool.query(
        `SELECT ${PROJECTION_COLUMNS} FROM settlement_projections WHERE state = $1`,
        ['unknown'],
      );
      return rows.map(mapProjectionRow);
    } catch (err) {
      this._degrade(`listUnknown failed: ${err.message}`);
      return super.listUnknown();
    }
  }

  /** Full, ordered event history for one settlement — the audit trail (#130). */
  async getEventLog(idempotencyKey) {
    if (this.degraded || !this.pool) return super.getEventLog(idempotencyKey);
    try {
      await this.ready;
      const { rows } = await this.pool.query(
        `SELECT idempotency_key, seq, event_type, event_version, payload, recorded_at
         FROM settlement_events WHERE idempotency_key = $1 ORDER BY seq ASC`,
        [idempotencyKey],
      );
      return rows.map(mapEventRow);
    } catch (err) {
      this._degrade(`getEventLog failed: ${err.message}`);
      return super.getEventLog(idempotencyKey);
    }
  }

  /**
   * Cross-aggregate, chronologically ordered export of every transition ever
   * recorded, for regulatory export (#130).
   */
  async exportAuditLog({ since, until, limit } = {}) {
    if (this.degraded || !this.pool) return super.exportAuditLog({ since, until, limit });
    try {
      await this.ready;
      const { rows } = await this.pool.query(
        `SELECT idempotency_key, seq, event_type, event_version, payload, recorded_at
         FROM settlement_events
         WHERE ($1::timestamptz IS NULL OR recorded_at >= $1)
           AND ($2::timestamptz IS NULL OR recorded_at <= $2)
         ORDER BY recorded_at ASC, id ASC
         LIMIT $3`,
        [since ?? null, until ?? null, limit ?? 10_000],
      );
      return rows.map(mapEventRow);
    } catch (err) {
      this._degrade(`exportAuditLog failed: ${err.message}`);
      return super.exportAuditLog({ since, until, limit });
    }
  }

  /**
   * Replays one aggregate's event log through the canonical fold and
   * overwrites its projection row with the result. The hot write path
   * (save/updateState) never calls this — it exists to repair or verify a
   * read model from the source of truth.
   */
  async rebuildProjection(idempotencyKey) {
    if (this.degraded || !this.pool) return super.rebuildProjection(idempotencyKey);
    try {
      await this.ready;
      const events = await this.getEventLog(idempotencyKey);
      const projection = projectSettlement(events);
      if (!projection) return null;
      const { rows } = await this.pool.query(
        `INSERT INTO settlement_projections (${PROJECTION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           network = EXCLUDED.network, scheme = EXCLUDED.scheme, payer = EXCLUDED.payer,
           pay_to = EXCLUDED.pay_to, asset = EXCLUDED.asset, amount = EXCLUDED.amount,
           state = EXCLUDED.state, tx_hash = EXCLUDED.tx_hash, error_reason = EXCLUDED.error_reason,
           error_message = EXCLUDED.error_message, response = EXCLUDED.response, key_id = EXCLUDED.key_id,
           version = EXCLUDED.version, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
         RETURNING ${PROJECTION_COLUMNS}`,
        [
          projection.idempotency_key,
          projection.network,
          projection.scheme,
          projection.payer,
          projection.pay_to,
          projection.asset,
          projection.amount,
          projection.state,
          projection.tx_hash,
          projection.error_reason,
          projection.error_message,
          projection.response ? JSON.stringify(projection.response) : null,
          projection.key_id,
          events.length,
          projection.created_at,
          projection.updated_at,
        ],
      );
      return mapProjectionRow(rows[0]);
    } catch (err) {
      this._degrade(`rebuildProjection failed: ${err.message}`);
      return super.rebuildProjection(idempotencyKey);
    }
  }
}
