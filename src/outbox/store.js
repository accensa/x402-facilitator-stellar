/**
 * Postgres-backed transactional outbox (#123).
 *
 * Guaranteed delivery of settlement notifications, decoupled from the request
 * path. The settle handler writes the `settled` state change AND the
 * notification into one transaction (see PostgresSettlementStore.settleAndEnqueue);
 * this store owns the `outbox_events` table that transaction writes to, and the
 * claim/publish/mark cycle the background worker runs.
 *
 * CONCURRENCY. Multiple replicas may run the worker. Rows are claimed with
 * `FOR UPDATE SKIP LOCKED` so two workers never hold the same row, and a claim
 * carries a lease: a worker that dies mid-publish leaves the row `claimed`
 * until the lease expires, then the next poll re-claims it. That is what makes
 * the guarantee at-least-once — a crash between publish and markup re-publishes
 * (duplicates possible, loss not).
 *
 * STATE MACHINE. `pending` -> `claimed` (worker owns it) -> `published`, or
 * back to `pending` on a failed publish (attempts++); after `maxAttempts` the
 * row goes `failed` and is left for an operator rather than retried forever.
 */

export const OUTBOX_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS outbox_events (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'claimed', 'published', 'failed')),
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
      ON outbox_events(status, created_at)
      WHERE status IN ('pending', 'claimed');
`;

export class OutboxStore {
  /**
   * @param {object} pool - pg Pool (or a test double with the same surface)
   * @param {object} [options]
   * @param {Function} [options.warn] - logger sink
   */
  constructor(pool, { warn = msg => console.warn(msg) } = {}) {
    this.pool = pool;
    this.warn = warn;
    this.ready = this._ensureTable();
  }

  async _ensureTable() {
    await this.pool.query(OUTBOX_TABLE_SQL);
  }

  /**
   * Inserts one event INSIDE an already-open transaction (the settlement
   * state change's transaction). `ON CONFLICT DO NOTHING` keeps the insert
   * idempotent on event_id.
   *
   * @param {object} client - checked-out pg client with an open transaction
   * @param {{eventId: string, type: string, payload: object}} event
   */
  async insertEvent(client, { eventId, type, payload }) {
    await client.query(
      `INSERT INTO outbox_events (event_id, type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, type, JSON.stringify(payload)],
    );
  }

  /**
   * Claims up to `limit` rows for this worker: pending rows plus claims whose
   * lease expired. The claim itself is the atomicity boundary — two workers
   * cannot claim the same row, and a dead worker's rows come back after
   * `leaseMs`.
   *
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {number} [options.leaseMs]
   * @returns {Promise<Array<{id: number, event_id: string, type: string, payload: object, attempts: number}>>}
   */
  async claimBatch({ limit = 50, leaseMs = 60_000 } = {}) {
    await this.ready;
    const { rows } = await this.pool.query(
      `UPDATE outbox_events SET
         status = 'claimed',
         claimed_at = NOW(),
         updated_at = NOW()
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE status = 'pending'
            OR (status = 'claimed' AND claimed_at < NOW() - ($2::int * INTERVAL '1 millisecond'))
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, event_id, type, payload, attempts, created_at`,
      [limit, leaseMs],
    );
    return rows.map(r => ({ ...r, payload: r.payload }));
  }

  /**
   * Records a successful publish. Called only after the broker acknowledged
   * the message, so a crash before this call leaves the row claimable again
   * and the event is re-published (at-least-once).
   */
  async markPublished(id) {
    await this.pool.query(
      `UPDATE outbox_events SET
         status = 'published',
         published_at = NOW(),
         claimed_at = NULL,
         last_error = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
  }

  /**
   * Records a failed publish: attempts++, and either back to `pending` (the
   * worker will retry next cycle) or to `failed` once maxAttempts is hit.
   */
  async markFailed(id, error, maxAttempts = 10) {
    await this.pool.query(
      `UPDATE outbox_events SET
         attempts = attempts + 1,
         last_error = $2,
         status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
         claimed_at = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id, String(error ?? '').slice(0, 2000), maxAttempts],
    );
  }

  /** Observable backlog (pending + unexpired claims). */
  async countPending() {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS count FROM outbox_events WHERE status IN ('pending', 'claimed')`,
    );
    return rows[0]?.count ?? 0;
  }
}
