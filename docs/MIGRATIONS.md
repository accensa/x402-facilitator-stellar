# Database Migrations — Expand and Contract

Zero-downtime schema changes for the x402 facilitator.

## Overview

Every schema change must be deployable while the previous version of the
application is still running. The **expand and contract** pattern achieves this
by splitting every change into two phases:

1. **Expand** — add new state (columns, tables, indexes) without removing or
   renaming anything the old code reads. Both old and new code work against the
   expanded schema.
2. **Contract** — remove the old state after the new code has been deployed and
   has been running stable for the agreed observation window.

The gap between expand and contract is the safety margin. Both the old and new
versions of the application must be able to run against the database at every
point in this sequence.

## Tooling

This project uses [node-pg-migrate](https://github.com/salsita/node-pg-migrate)
for schema migrations. It operates against the same `DATABASE_URL` the service
uses and tracks applied migrations in a `pgmigrations` table.

### Scripts

| Command | Description |
|---|---|
| `npm run db:migrate` | Apply all pending migrations |
| `npm run db:migrate:down` | Rollback the last migration |
| `npm run db:status` | Show applied and pending migrations |
| `npm run db:seed-legacy` | Register pre-node-pg-migrate SQL as applied |
| `npm run check:migration` | CI guardrail: check backward compatibility |

### Creating a new migration

```bash
node scripts/db-migrate.js up
```

Or create the file manually in `migrations/` with a timestamp prefix:

```
migrations/
  001_bazaar_catalog.js
  002_idempotency_keys.js
  003_rate_limit_buckets.js
  004_sample_expand_add_access_tier.js
  005_sample_contract_drop_access_tier.js
  20260826000000_your_change.js    # <- timestamp prefix for ordering
```

Each file exports `up(pgm)` and `down(pgm)` functions. The `pgm` parameter
provides a builder API for safe DDL changes.

## The Expand and Contract Pattern

### Phase 1: Expand (backward-compatible)

The expand migration adds new state that old code ignores:

```javascript
// migrations/20260826000000_expand_add_feature_flags.js
export const up = pgm => {
  // Nullable column: old code does not know about it, which is fine.
  pgm.addColumn('discovery_resources', 'feature_flags', {
    type: 'JSONB',
  });
};

export const down = pgm => {
  pgm.dropColumn('discovery_resources', 'feature_flags');
};
```

**Rules for expand migrations:**

- New columns MUST be nullable or have a DEFAULT value. Old code inserts rows
  without the column; a NOT NULL without DEFAULT will reject them.
- Never DROP or RENAME anything the old code reads. Use ADD COLUMN instead.
- Prefer `pgm.createIndex(..., { concurrently: true })` for indexes on live
  tables to avoid blocking reads.
- Never use `LOCK TABLE`. It blocks all reads and writes.

### Phase 2: Deploy and observe

1. Deploy the expand migration to production.
2. Deploy the new application code that reads/writes the new column.
3. Monitor for errors, performance regressions, and data consistency.
4. Wait for the agreed observation window (default: 2 deploys or 72 hours).

During this window, both old and new code can run against the same schema.

### Phase 3: Contract (cleanup)

The contract migration removes the old state:

```javascript
// migrations/20260901000000_contract_drop_feature_flags.js
export const up = pgm => {
  pgm.dropColumn('discovery_resources', 'feature_flags');
};

export const down = pgm => {
  pgm.addColumn('discovery_resources', 'feature_flags', {
    type: 'JSONB',
  });
};
```

**Rules for contract migrations:**

- Only drop columns/tables that no running code references.
- Verify with a query against `pg_stat_activity` that no long-running
  transactions still reference the old schema.
- The down migration must be able to recreate the state (for rollback safety).

## Column Rename Pattern

Column renames require a two-step expand-and-contract:

```
Schema v1:  status VARCHAR(50)
            ↓
Expand:     status VARCHAR(50)       -- kept, old code reads/writes here
            access_tier VARCHAR(50)  -- new, nullable
            ↓
Code deploy: writes to BOTH columns, reads from access_tier
            ↓
Backfill:   UPDATE ... SET access_tier = status WHERE access_tier IS NULL
            ↓
Contract:   DROP COLUMN status       -- no code references it anymore
```

Never use `RENAME COLUMN`. It breaks running code instantly.

## CI Guardrails

The CI pipeline runs `npm run check:migration` on every PR that touches the
`migrations/` directory. It catches:

- DROP TABLE or DROP COLUMN in expand (up) migrations
- RENAME TABLE or COLUMN (must use expand-and-contract instead)
- LOCK TABLE (blocks reads)
- NOT NULL without DEFAULT on existing tables
- CREATE INDEX without CONCURRENTLY (locks the table)
- Missing contract migration for an expand migration

Blocking errors prevent merge. Warnings are non-blocking but must be reviewed.

## Bootstrapping Existing Databases

If your database already has tables from the original `.sql` migration files,
register them as applied before using node-pg-migrate:

```bash
npm run db:seed-legacy
```

This inserts records into `pgmigrations` for the three original SQL migrations
so node-pg-migrate knows they are done and will not re-create them.

For fresh databases, run `npm run db:migrate` — it applies all migrations from
scratch.

## Docker Compose Integration

The facilitator container runs migrations automatically on startup:

```dockerfile
# In your Dockerfile or entrypoint:
CMD ["sh", "-c", "node scripts/db-migrate.js up && node src/server.js"]
```

Or run migrations as a separate init container:

```yaml
# docker-compose.yml
db-migrate:
  image: facilitator
  command: node scripts/db-migrate.js up
  environment:
    - DATABASE_URL=postgres://postgres:postgres@db:5432/x402_facilitator
  depends_on:
    db:
      condition: service_healthy
```

## Rollback

To undo the last migration:

```bash
npm run db:migrate:down
```

To undo multiple migrations:

```bash
node scripts/db-migrate.js down 3
```

**Important:** Rollback in production should be a conscious decision. The
`down()` function in each migration must restore the schema to its previous
state. Test rollbacks in staging before relying on them.

## Checklist for Schema Changes

Use this checklist when proposing a migration:

- [ ] Does this migration add state (expand) or remove state (contract)?
- [ ] Can old code run against the schema after this migration is applied?
- [ ] Does the expand migration only ADD columns/tables/indexes?
- [ ] Does the contract migration only DROP things no code references?
- [ ] Is there a backfill plan for any NOT NULL columns?
- [ ] Does this need a concurrent index (large table)?
- [ ] Has `npm run check:migration` been run locally?
- [ ] Has the observation window passed before the contract phase?
