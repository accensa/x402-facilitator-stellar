/**
 * Postgres-backed dead-letter store.
 *
 * The canonical DLQ regardless of which delivery path a message fell out of
 * (outbox worker, Kafka consumer group, or the direct fire-and-forget path —
 * see the callers in src/outbox/worker.js and src/webhooks/dispatcher.js).
 * Centralising it here rather than per-path is what lets the operator API and
 * the retry worker stay single implementations instead of three.
 *
 * STATE MACHINE. `pending` -> (retry worker attempts redelivery) -> `resolved`
 * on success, or back to `pending` with a later `next_retry_at` on failure,
 * until `dlq_attempts` hits the configured ceiling and it becomes `exhausted`.
 * From `pending` or `exhausted` an operator can `discard` (permanent) or force
 * an immediate `replay` outside the backoff schedule.
 */

export const DEAD_LETTERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS dead_letters (
      id BIGSERIAL PRIMARY KEY,
      message_id TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT,
      payload JSONB NOT NULL,
      error TEXT,
      delivery_attempts INT NOT NULL DEFAULT 0,
      dlq_attempts INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'exhausted', 'resolved', 'discarded')),
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ,
      first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_dead_letters_retry ON dead_letters(status, next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_dead_letters_message_id ON dead_letters(message_id);
`;

/**
 * A repeated failure of the same message from the same delivery path must
 * update the existing row, not append another. The unique index is created
 * separately from the table DDL so an existing table that predates it (and may
 * already contain duplicate rows) can be merged first instead of failing boot.
 */
export const DEAD_LETTERS_UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dead_letters_message_source
      ON dead_letters(message_id, source);
`;

/**
 * Collapses rows that predate the unique index. The newest row per
 * (message_id, source) survives because it carries the latest error and
 * timestamps; its delivery_attempts becomes the sum across the duplicates so
 * the failure history is not lost.
 */
export const DEAD_LETTERS_MERGE_DUPLICATES_SQL = `
  WITH ranked AS (
    SELECT id,
           CAST(SUM(delivery_attempts) OVER (PARTITION BY message_id, source) AS int)
             AS total_attempts,
           ROW_NUMBER() OVER (PARTITION BY message_id, source ORDER BY id DESC) AS rn
    FROM dead_letters
  ),
  merged AS (
    UPDATE dead_letters d
    SET delivery_attempts = r.total_attempts,
        updated_at = now()
    FROM ranked r
    WHERE d.id = r.id
      AND r.rn = 1
      AND r.total_attempts <> d.delivery_attempts
    RETURNING d.id
  )
  DELETE FROM dead_letters d
  USING ranked r
  WHERE d.id = r.id
    AND r.rn > 1;
`;

export class DeadLetterStore {
  /**
   * @param {object} pool - pg Pool (or a test double with the same surface)
   * @param {object} [options]
   * @param {Function} [options.warn]
   */
  constructor(pool, { warn = msg => console.warn(msg) } = {}) {
    this.pool = pool;
    this.warn = warn;
    this.ready = this._ensureTable();
  }

  async _ensureTable() {
    await this.pool.query(DEAD_LETTERS_TABLE_SQL);
    try {
      await this.pool.query(DEAD_LETTERS_UNIQUE_INDEX_SQL);
    } catch (err) {
      if (err?.code !== '23505') throw err;
      this.warn(
        '[DLQ] duplicate (message_id, source) rows found; merging them before creating the unique index',
      );
      await this.pool.query(DEAD_LETTERS_MERGE_DUPLICATES_SQL);
      await this.pool.query(DEAD_LETTERS_UNIQUE_INDEX_SQL);
    }
  }

  /**
   * Records a message whose delivery path exhausted its own retry budget.
   *
   * Repeated failures of the same (message_id, source) update the existing
   * row: the delivery attempt counter increments, the latest error/payload is
   * kept, and both failure timestamps are refreshed. `first_failed_at` and
   * `created_at` stay at the original failure.
   *
   * @param {object} event
   * @param {string} event.messageId
   * @param {string} event.source - 'outbox' | 'kafka-consumer' | 'direct'
   * @param {string} [event.type]
   * @param {object} event.payload
   * @param {string} [event.error]
   * @param {number} [event.deliveryAttempts]
   * @returns {Promise<number>} the row's id (existing row on a duplicate failure)
   */
  async insert({ messageId, source, type = null, payload, error = null, deliveryAttempts = 0 }) {
    await this.ready;
    const { rows } = await this.pool.query(
      `INSERT INTO dead_letters (message_id, source, type, payload, error, delivery_attempts)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id, source) DO UPDATE SET
         delivery_attempts = dead_letters.delivery_attempts + 1,
         type = COALESCE(EXCLUDED.type, dead_letters.type),
         payload = EXCLUDED.payload,
         error = EXCLUDED.error,
         last_failed_at = NOW(),
         updated_at = NOW()
       RETURNING id`,
      [messageId, source, type, JSON.stringify(payload), error, deliveryAttempts],
    );
    return rows[0].id;
  }

  /**
   * Claims up to `limit` rows due for a DLQ retry: `pending` rows whose
   * `next_retry_at` has passed, plus claims whose lease expired (a worker
   * that died mid-retry). Mirrors OutboxStore.claimBatch's `FOR UPDATE SKIP
   * LOCKED` pattern so multiple replicas never race the same row.
   */
  async claimDue({ limit = 50, leaseMs = 60_000 } = {}) {
    await this.ready;
    const { rows } = await this.pool.query(
      `UPDATE dead_letters SET
         claimed_at = NOW(),
         updated_at = NOW()
       WHERE id IN (
         SELECT id FROM dead_letters
         WHERE status = 'pending'
           AND next_retry_at <= NOW()
           AND (claimed_at IS NULL OR claimed_at < NOW() - ($2::int * INTERVAL '1 millisecond'))
         ORDER BY next_retry_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, message_id, source, type, payload, error, delivery_attempts, dlq_attempts`,
      [limit, leaseMs],
    );
    return rows;
  }

  /** A DLQ retry delivered successfully — terminal, kept for the audit trail. */
  async markResolved(id) {
    await this.pool.query(
      `UPDATE dead_letters SET
         status = 'resolved',
         resolved_at = NOW(),
         claimed_at = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
  }

  /**
   * A DLQ retry failed: dlq_attempts++, exponential backoff on next_retry_at,
   * `exhausted` once maxDlqAttempts is reached (an operator must act from there).
   */
  async markRetryFailed(id, error, { maxDlqAttempts = 5, baseBackoffMs = 30_000 } = {}) {
    await this.pool.query(
      `UPDATE dead_letters SET
         dlq_attempts = dlq_attempts + 1,
         error = $2,
         last_failed_at = NOW(),
         status = CASE WHEN dlq_attempts + 1 >= $3 THEN 'exhausted' ELSE 'pending' END,
         next_retry_at = NOW() + ($4::float * POWER(2, dlq_attempts) * INTERVAL '1 millisecond'),
         claimed_at = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id, String(error ?? '').slice(0, 2000), maxDlqAttempts, baseBackoffMs],
    );
  }

  async get(id) {
    await this.ready;
    const { rows } = await this.pool.query(`SELECT * FROM dead_letters WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Operator action: permanently discard a message — never retried again. */
  async discard(id) {
    await this.pool.query(
      `UPDATE dead_letters SET status = 'discarded', updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  /**
   * Paginated listing for the operator API, newest first. `status` filters to
   * one state; omitted means every state.
   */
  async list({ status = null, limit = 50, offset = 0 } = {}) {
    await this.ready;
    const clampedLimit = Math.min(Math.max(1, limit), 200);
    const clampedOffset = Math.max(0, offset);
    const params = status ? [status, clampedLimit, clampedOffset] : [clampedLimit, clampedOffset];
    const where = status ? 'WHERE status = $1' : '';
    const { rows } = await this.pool.query(
      `SELECT * FROM dead_letters ${where}
       ORDER BY created_at DESC
       LIMIT $${status ? 2 : 1} OFFSET $${status ? 3 : 2}`,
      params,
    );
    const { rows: countRows } = await this.pool.query(
      `SELECT count(*)::int AS count FROM dead_letters ${where}`,
      status ? [status] : [],
    );
    return { items: rows, total: countRows[0]?.count ?? 0 };
  }

  /** Depth per status — the DLQ_depth gauge and the alert-threshold check read this. */
  async countByStatus() {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT status, count(*)::int AS count FROM dead_letters GROUP BY status`,
    );
    const counts = { pending: 0, exhausted: 0, resolved: 0, discarded: 0 };
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }
}
