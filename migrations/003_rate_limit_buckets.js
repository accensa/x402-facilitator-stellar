/**
 * 003: Shared state for the rate limiter / usage meter.
 *
 * One row per limiter bucket. bucket_id embeds owner, counter type, window
 * start and window size, e.g. "key_0:settle:1735689600:3600". Expired windows
 * are swept opportunistically by the service; rows are never evicted under
 * memory pressure, which is precisely why a daily fee ceiling is safe here.
 *
 * Converted from the original 002_rate_limit_buckets.sql for node-pg-migrate.
 */

export const up = pgm => {
  pgm.createTable('rate_limit_buckets', {
    bucket_id: { type: 'TEXT', primaryKey: true },
    count: { type: 'BIGINT', notNull: true, default: 0 },
    reset_at: { type: 'BIGINT', notNull: true },
  });

  pgm.createIndex('rate_limit_buckets', 'reset_at');
};

export const down = pgm => {
  pgm.dropTable('rate_limit_buckets');
};
