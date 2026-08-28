/**
 * 005: SAMPLE CONTRACT — remove access_tier from discovery_resources.
 *
 * Demonstrates the contract phase of the expand-and-contract migration pattern
 * (see docs/MIGRATIONS.md). This migration removes the column added in 004.
 *
 * PREREQUISITES before running this in production:
 *   1. The expand migration (004) has been applied.
 *   2. All application code has been updated to no longer reference access_tier.
 *   3. The previous release (without access_tier reads) has been deployed and
 *      has been running stable for the agreed observation window.
 *   4. No feature flags or A/B tests reference this column.
 *
 * SAFETY: This drops the column directly. For a column rename, the contract
 * phase would drop the OLD column (the one no longer read or written). The
 * old column must be confirmed unused before removal — see MIGRATIONS.md.
 */

export const up = pgm => {
  pgm.dropColumn('discovery_resources', 'access_tier');
};

export const down = pgm => {
  pgm.addColumn('discovery_resources', 'access_tier', {
    type: 'VARCHAR(50)',
  });

  pgm.createIndex('discovery_resources', 'access_tier', { where: 'access_tier IS NOT NULL' });
};
