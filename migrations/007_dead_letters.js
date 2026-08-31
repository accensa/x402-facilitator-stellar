/**
 * 007: Dead-letter queue for poisoned webhook messages.
 *
 * A message lands here once its normal delivery path (the outbox worker, the
 * Kafka consumer group, or the direct fire-and-forget path) has exhausted its
 * own retry budget (see src/webhooks/dispatcher.js's `deliverWebhook` and
 * src/outbox/worker.js). Before this table existed, that message was either
 * silently dropped (direct/Kafka paths) or stuck as an unreachable `failed`
 * row with no operator surface (outbox path).
 *
 * `next_retry_at` drives a second, independent backoff schedule (src/dlq/worker.js)
 * separate from the original delivery backoff — a message here has already
 * proven the receiver was down for the original budget, so retries here are
 * slower and bounded by DLQ_MAX_RETRY_ATTEMPTS before landing in `exhausted`,
 * where only an operator (via the replay/discard API) can move it.
 */

export const up = pgm => {
  pgm.createTable('dead_letters', {
    id: 'id',
    // Correlates back to the originating outbox event_id or Kafka message key
    // when one exists; a generated id for the direct-delivery path.
    message_id: { type: 'TEXT', notNull: true },
    // Which delivery path dead-lettered this message: 'outbox' | 'kafka-consumer' | 'direct'.
    source: { type: 'TEXT', notNull: true },
    type: { type: 'TEXT' },
    payload: { type: 'JSONB', notNull: true },
    error: { type: 'TEXT' },
    // Delivery attempts made on the original path before it gave up.
    delivery_attempts: { type: 'INT', notNull: true, default: 0 },
    // Retries attempted from this table by the DLQ worker.
    dlq_attempts: { type: 'INT', notNull: true, default: 0 },
    status: {
      type: 'TEXT',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'exhausted', 'resolved', 'discarded')",
    },
    next_retry_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    claimed_at: { type: 'TIMESTAMPTZ' },
    first_failed_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    last_failed_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'TIMESTAMPTZ' },
    created_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
  });

  // The DLQ worker's poll query filters on exactly this.
  pgm.createIndex('dead_letters', ['status', 'next_retry_at']);
  pgm.createIndex('dead_letters', 'message_id');
};

export const down = pgm => {
  pgm.dropTable('dead_letters');
};
