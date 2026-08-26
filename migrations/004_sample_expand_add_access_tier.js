/**
 * 004: SAMPLE EXPAND — add access_tier to discovery_resources.
 *
 * Demonstrates the expand phase of the expand-and-contract migration pattern
 * (see docs/MIGRATIONS.md). This migration is backward-compatible: it adds a
 * nullable column with a default, so old code that does not reference the
 * column continues to work unchanged.
 *
 * The column is NULL by default (no DEFAULT clause), meaning existing rows
 * get NULL and new inserts must supply the value explicitly. This avoids a
 * full-table rewrite that a non-null DEFAULT would trigger.
 *
 * RENAME scenario:
 *   If this were renaming an existing column (e.g. `status` -> `access_tier`),
 *   the expand phase would:
 *     1. ADD the new column (this migration)
 *     2. Deploy code that WRITES to both columns
 *     3. Backfill old column -> new column
 *     4. Deploy code that READS from the new column
 *     5. (This migration) — contract phase drops the old column
 *
 * This sample adds a fresh column instead of a rename for simplicity.
 */

export const up = pgm => {
  // Nullable column: no full-table rewrite, old rows get NULL.
  pgm.addColumn('discovery_resources', 'access_tier', {
    type: 'VARCHAR(50)',
  });

  // Partial index: only index non-NULL values. Most resources are
  // public (NULL tier); the index covers the interesting subset.
  pgm.createIndex('discovery_resources', 'access_tier', { where: 'access_tier IS NOT NULL' });

  pgm.sql(`
    COMMENT ON COLUMN discovery_resources.access_tier
    IS 'Access classification: NULL (public), partner, premium, internal'
  `);
};

export const down = pgm => {
  pgm.dropColumn('discovery_resources', 'access_tier');
};
