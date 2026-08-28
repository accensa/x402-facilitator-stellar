/**
 * 002: Persistent idempotency keys for /settle.
 *
 * The unique constraint on `key` is the actual mechanism: two instances behind
 * a load balancer can both attempt to claim the same retry, and exactly one
 * INSERT succeeds. The loser polls for the winner's recorded response.
 * Claims with a NULL response are in flight or failed; they are re-claimable.
 *
 * Converted from the original 002_idempotency_keys.sql for node-pg-migrate.
 */

export const up = pgm => {
  pgm.createTable('idempotency_keys', {
    key: { type: 'TEXT', primaryKey: true },
    status_code: { type: 'INTEGER', notNull: true, default: 200 },
    response: { type: 'JSONB' },
    created_at: { type: 'TIMESTAMPTZ', notNull: true, default: 'now()' },
    completed_at: { type: 'TIMESTAMPTZ' },
  });

  // Index only what retention cleanup needs.
  pgm.createIndex('idempotency_keys', 'created_at');
};

export const down = pgm => {
  pgm.dropTable('idempotency_keys');
};
