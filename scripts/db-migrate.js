#!/usr/bin/env node

/**
 * Database migration runner.
 *
 * Wraps node-pg-migrate's programmatic API for use in deployment pipelines,
 * container entrypoints, and development workflows. Reads DATABASE_URL from
 * the environment — the same variable the rest of the service uses.
 *
 * Usage:
 *   node scripts/db-migrate.js up          # apply pending migrations
 *   node scripts/db-migrate.js down        # rollback last migration
 *   node scripts/db-migrate.js down 3      # rollback 3 migrations
 *   node scripts/db-migrate.js status      # show migration state
 *   node scripts/db-migrate.js seed-legacy # mark pre-node-pg-migrate SQL as applied
 */

import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Resolve the database URL from the environment. Supports both DATABASE_URL
 * and the legacy POSTGRES_URL fallback some tooling sets.
 */
function resolveDatabaseUrl() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Cannot run migrations without a target database.');
    process.exit(1);
  }
  return url;
}

/**
 * List migration files in the migrations directory, sorted by filename.
 * Filters to .js files only (node-pg-migrate format).
 */
export async function listMigrationFiles() {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter(f => f.endsWith('.js')).sort();
}

/**
 * List the legacy .sql migration files in the migrations directory, sorted
 * by filename (#500).
 *
 * These are psql-only: this runner never applies them and `down` never rolls
 * them back. They are applied through the documented psql path (see
 * docs/DEPLOYMENT.md) and, on databases that already have their tables,
 * recorded via `seed-legacy`. The duplicate stems (001_bazaar_catalog,
 * 002_idempotency_keys, present as both .js and .sql) and the
 * 002_rate_limit_buckets.sql / 003_rate_limit_buckets.js collision resolve to
 * one defined ordering used by `up`, `down` and `status` alike:
 * lexicographic by filename, with the runner-managed .js set applied by
 * node-pg-migrate in that order and the .sql set listed alongside in that
 * order but left for the psql path.
 */
export async function listSqlMigrationFiles() {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter(f => f.endsWith('.sql')).sort();
}

/**
 * The .sql stems on disk, in filename order (#500). This is the exact set
 * `seed-legacy` records — every .sql basename, including the three files the
 * old list omitted (002_rate_limit_buckets, 003_settlement_store,
 * 004_outbox_events, 004_settlement_events) and with the non-existent
 * 003_rate_limit_buckets corrected to the on-disk 002_rate_limit_buckets.
 */
export const LEGACY_MIGRATIONS = [
  { name: '001_bazaar_catalog' },
  { name: '002_idempotency_keys' },
  { name: '002_rate_limit_buckets' },
  { name: '003_settlement_store' },
  { name: '004_outbox_events' },
  { name: '004_settlement_events' },
];

/**
 * Pure helper: .js files whose stem is not in the applied-name set, in the
 * defined (lexicographic) order. What this returns as pending is exactly what
 * `up` applies and what `down` can roll back, keeping the tracking table
 * consistent in both directions.
 */
export function findPendingJs(appliedNames, jsFiles) {
  return jsFiles.filter(f => !appliedNames.has(f.replace(/\.js$/, '')));
}

/**
 * Pure helper: legacy .sql stems with no tracking row in pgmigrations.
 * `sqlFiles` are filenames (with .sql); the comparison is on stems, the same
 * values `seed-legacy` records.
 */
export function findUntrackedLegacy(appliedNames, sqlFiles) {
  return sqlFiles.filter(f => !appliedNames.has(f.replace(/\.sql$/, '')));
}

/**
 * Refuse `up` while legacy .sql files are untracked (#500).
 *
 * The runner never applies .sql itself — they go through the documented psql
 * path — so starting `up` on a database that never received them would leave
 * the schema half-built while reporting success. Instead, list every untracked
 * .sql file and stop; the operator either applies them via psql or runs
 * `seed-legacy` when the tables already exist, then re-runs `up`.
 *
 * `down` is intentionally not gated: it only rolls back what this runner
 * applied (the .js set via node-pg-migrate), which is well-defined regardless
 * of legacy state.
 */
async function gateUntrackedLegacy(pool) {
  const tableCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'pgmigrations'
    )
  `);
  const appliedNames = new Set();
  if (tableCheck.rows[0].exists) {
    const { rows } = await pool.query('SELECT name FROM pgmigrations');
    for (const r of rows) appliedNames.add(r.name);
  }
  const sqlFiles = await listSqlMigrationFiles();
  return findUntrackedLegacy(appliedNames, sqlFiles);
}

/**
 * Run the node-pg-migrate runner with the given direction.
 */
async function runMigration(direction, count) {
  const { runner } = require('node-pg-migrate');
  const databaseUrl = resolveDatabaseUrl();

  if (direction === 'up') {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const untracked = await gateUntrackedLegacy(pool);
      if (untracked.length > 0) {
        console.error(
          `Refusing to apply .js migrations: ${untracked.length} legacy .sql file(s) ` +
            'are not tracked in pgmigrations and this runner never applies .sql files.',
        );
        for (const f of untracked) console.error(`  ${f}`);
        console.error(
          'Apply them through the documented psql path, or run ' +
            '`node scripts/db-migrate.js seed-legacy` if their tables already exist, ' +
            'then re-run `up`.',
        );
        process.exit(1);
      }
    } finally {
      await pool.end();
    }
  }

  const options = {
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count: count || Infinity,
    migrationsTable: 'pgmigrations',
    logger: msg => console.log(msg),
  };

  try {
    await runner(options);
    console.log(`Migration ${direction} completed successfully.`);
  } catch (err) {
    console.error(`Migration ${direction} failed:`, err.message);
    process.exit(1);
  }
}

/**
 * Show the current migration state by querying the pgmigrations table.
 */
async function showStatus() {
  const { Pool } = require('pg');
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Check if the migrations table exists.
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'pgmigrations'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('No migrations have been applied yet (pgmigrations table does not exist).');
      return;
    }

    const { rows } = await pool.query('SELECT id, name, run_on FROM pgmigrations ORDER BY id');

    if (rows.length === 0) {
      console.log('No migrations have been applied yet.');
      return;
    }

    console.log('Applied migrations:');
    console.log('─'.repeat(70));
    for (const row of rows) {
      const date = new Date(row.run_on).toISOString();
      console.log(`  ${String(row.id).padStart(4)}  ${row.name.padEnd(45)} ${date}`);
    }

    // Compare with available migration files.
    const files = await listMigrationFiles();
    const sqlFiles = await listSqlMigrationFiles();
    const appliedNames = new Set(rows.map(r => r.name));
    const pending = findPendingJs(appliedNames, files);
    // Legacy .sql files are never applied by this runner; report the ones
    // with no tracking row instead of claiming the schema is up to date.
    const untrackedLegacy = findUntrackedLegacy(appliedNames, sqlFiles);

    if (pending.length > 0) {
      console.log('\nPending migrations:');
      console.log('─'.repeat(70));
      for (const f of pending) {
        console.log(`  ${f}`);
      }
    }

    if (untrackedLegacy.length > 0) {
      console.log('\nLegacy SQL migrations (psql path — not applied by this runner):');
      console.log('─'.repeat(70));
      for (const f of untrackedLegacy) {
        console.log(`  ${f}`);
      }
      console.log(
        'Apply them through the documented psql path, or run ' +
          '`node scripts/db-migrate.js seed-legacy` if their tables already exist.',
      );
    }

    if (pending.length === 0 && untrackedLegacy.length === 0) {
      console.log('\nAll migrations are up to date.');
    } else {
      const parts = [];
      if (pending.length > 0) parts.push(`${pending.length} pending .js migration(s)`);
      if (untrackedLegacy.length > 0)
        parts.push(`${untrackedLegacy.length} legacy .sql file(s) need the psql path`);
      console.log(`\nNot up to date: ${parts.join('; ')}.`);
    }
  } finally {
    await pool.end();
  }
}

/**
 * Bootstrap: mark legacy SQL migrations as applied in pgmigrations.
 *
 * For databases that already have the tables from the original .sql files,
 * this inserts synthetic records so node-pg-migrate knows they are done and
 * will not attempt to re-create them.
 *
 * Idempotent: skips names that are already recorded.
 */
async function seedLegacy() {
  const { Pool } = require('pg');
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl });

  // Exactly the .sql stems on disk, in filename order (#500). The id is left
  // to the SERIAL default so re-seeding an older three-row table can never
  // collide on the primary key; ON CONFLICT (name) keeps a second run a no-op.
  const legacyMigrations = LEGACY_MIGRATIONS;

  try {
    // Ensure the migrations table exists.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pgmigrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        run_on TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const m of legacyMigrations) {
      const result = await pool.query(
        'INSERT INTO pgmigrations (name, run_on) VALUES ($1, now()) ON CONFLICT (name) DO NOTHING',
        [m.name],
      );
      if (result.rowCount > 0) {
        console.log(`  Seeded: ${m.name}`);
      } else {
        console.log(`  Already tracked: ${m.name}`);
      }
    }

    console.log('Legacy migration seeding complete.');
  } finally {
    await pool.end();
  }
}

// ── CLI dispatch ────────────────────────────────────────────────────────
// Guarded so test/db-migrate.sql.test.js can import the helpers above
// without running the CLI (importing must never process.exit).

const invokedAsScript =
  typeof process.argv[1] === 'string' && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedAsScript) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'up':
      await runMigration('up');
      break;
    case 'down': {
      const count = args[0] ? Number(args[0]) : 1;
      if (!Number.isFinite(count) || count < 1) {
        console.error('Usage: node scripts/db-migrate.js down [count]');
        process.exit(1);
      }
      await runMigration('down', count);
      break;
    }
    case 'status':
      await showStatus();
      break;
    case 'seed-legacy':
      await seedLegacy();
      break;
    default:
      console.error('Usage: node scripts/db-migrate.js <up|down|status|seed-legacy> [count]');
      process.exit(1);
  }
}
