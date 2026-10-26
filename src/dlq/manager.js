/**
 * Operator-facing dead-letter queue manager.
 *
 * Wraps DeadLetterStore (src/dlq/store.js) with the interactive operator
 * surface: inspect pending/exhausted messages, replay a single message
 * immediately (outside the backoff schedule), purge discarded/resolved or
 * aged messages, and emit an alert when DLQ depth breaches a configured
 * threshold.
 *
 * The manager is store-agnostic: any object with `insert`, `get`, `list`,
 * `markResolved`, `markRetryFailed`, `countByStatus` and a `pool` (for purge)
 * works, which keeps unit tests free of Postgres.
 */

export class DeadLetterManager {
  /**
   * @param {object} store - a DeadLetterStore (or test double)
   * @param {object} [options]
   * @param {Function} [options.warn]
   * @param {Function} [options.onAlert] - fires once per threshold breach
   */
  constructor(store, { warn = msg => console.warn(msg), onAlert = warn } = {}) {
    this.store = store;
    this.warn = warn;
    this.onAlert = onAlert;
    this._alerting = false;
  }

  /**
   * Records a message whose delivery path exhausted its retry budget.
   * @returns {Promise<number>} the new row's id
   */
  async enqueue({ messageId, source, type = null, payload, error = null, deliveryAttempts = 0 }) {
    return this.store.insert({ messageId, source, type, payload, error, deliveryAttempts });
  }

  /** Paginated inspection, newest first. `status` filters to one state. */
  async inspect({ status = null, limit = 50, offset = 0 } = {}) {
    return this.store.list({ status, limit, offset });
  }

  /** Fetch a single dead letter by id. */
  async get(id) {
    return this.store.get(id);
  }

  /**
   * Immediate redelivery of one dead letter, outside the backoff schedule.
   * Resolves with the outcome so an operator sees the result of their action.
   * @param {number} id - dead letter row id
   * @param {(record: object) => Promise<unknown>} publish - redelivery function
   * @returns {Promise<{delivered: boolean, error?: string}>}
   */
  async replay(id, publish) {
    const row = await this.store.get(id);
    if (!row) return { delivered: false, error: 'not_found' };
    if (row.status === 'discarded') {
      return { delivered: false, error: 'already_discarded' };
    }
    if (row.status === 'resolved') {
      return { delivered: false, error: 'already_resolved' };
    }
    try {
      await publish(row.payload);
      await this.store.markResolved(row.id);
      return { delivered: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.markRetryFailed(row.id, message);
      return { delivered: false, error: message };
    }
  }

  /**
   * Purge dead letters matching the given criteria. At least one of `status`
   * or `olderThan` must be supplied so an operator never wipes the table by
   * accident.
   * @param {object} [options]
   * @param {string} [options.status] - one status to purge
   * @param {string|Date} [options.olderThan] - purge rows created before this
   * @returns {Promise<{purged: number}>} row count removed
   */
  async purge({ status = null, olderThan = null } = {}) {
    const conditions = [];
    const params = [];
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (olderThan) {
      conditions.push(`created_at < $${params.length + 1}`);
      params.push(olderThan instanceof Date ? olderThan.toISOString() : olderThan);
    }
    if (!conditions.length) {
      throw new Error('dlq purge requires a status or olderThan filter');
    }
    const { rowCount } = await this.store.pool.query(
      `DELETE FROM dead_letters WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return { purged: rowCount ?? 0 };
  }

  /** Actionable depth: pending + exhausted messages awaiting operator attention. */
  async dlqSize() {
    const counts = await this.store.countByStatus();
    return counts.pending + counts.exhausted;
  }

  /**
   * Check depth against `threshold`. When `pending + exhausted` crosses it,
   * `onAlert` fires at most once per breach and resets once depth drops back
   * under. Returns whether the threshold is currently breached.
   * @param {number} threshold - 0 disables the check
   * @returns {Promise<boolean>}
   */
  async checkThreshold(threshold = 0) {
    if (threshold <= 0) {
      this._alerting = false;
      return false;
    }
    const counts = await this.store.countByStatus();
    const actionable = counts.pending + counts.exhausted;
    const breached = actionable > threshold;
    if (breached && !this._alerting) {
      this._alerting = true;
      this.onAlert(counts);
    } else if (!breached) {
      this._alerting = false;
    }
    return breached;
  }
}
