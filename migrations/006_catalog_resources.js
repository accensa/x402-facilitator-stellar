/**
 * 006: Durable catalog — catalog_resources table (#139).
 *
 * Backing store for the catalog. `key` mirrors the in-memory identity
 * (url::toolName for mcp, url:: for http) so a restart can rebuild the exact
 * same entries. The provenance and lifetime columns mirror the in-memory
 * entry (#140): `provisional` is true only for verify-but-unpaid listings and
 * `expires_at` carries their window, so an operator can audit which listings
 * came from a /verify versus a settled payment, and the store's boot
 * hydration reproduces the same public/private view.
 *
 * `embedding` holds the semantic-search vector when one exists, written back
 * by the store as soon as the background embed completes, so /discovery/search
 * is warm immediately after a restart (no wholesale re-embedding).
 */

export const up = pgm => {
  pgm.createTable('catalog_resources', {
    key: { type: 'TEXT', primaryKey: true },
    resource: { type: 'JSONB', notNull: true },
    source: { type: 'TEXT', notNull: true, default: 'manual' },
    provisional: { type: 'BOOLEAN', notNull: true, default: false },
    expires_at: { type: 'BIGINT' },
    first_seen_at: { type: 'TIMESTAMPTZ', notNull: true },
    last_seen_at: { type: 'TIMESTAMPTZ', notNull: true },
    embedding: { type: 'JSONB' },
  });

  pgm.createIndex('catalog_resources', 'source');
  pgm.createIndex('catalog_resources', 'provisional');
};

export const down = pgm => {
  pgm.dropTable('catalog_resources');
};
