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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

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
async function listMigrationFiles() {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter(f => f.endsWith('.js')).sort();
}

/**
 * Run the node-pg-migrate runner with the given direction.
 */
async function runMigration(direction, count) {
  const { runner } = require('node-pg-migrate');
  const databaseUrl = resolveDatabaseUrl();

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
    const appliedNames = new Set(rows.map(r => r.name));
    const pending = files.filter(f => !appliedNames.has(f.replace('.js', '')));

    if (pending.length > 0) {
      console.log('\nPending migrations:');
      console.log('─'.repeat(70));
      for (const f of pending) {
        console.log(`  ${f}`);
      }
    } else {
      console.log('\nAll migrations are up to date.');
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

  const legacyMigrations = [
    { name: '001_bazaar_catalog', id: 1 },
    { name: '002_idempotency_keys', id: 2 },
    { name: '003_rate_limit_buckets', id: 3 },
  ];

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
        'INSERT INTO pgmigrations (id, name, run_on) VALUES ($1, $2, now()) ON CONFLICT (name) DO NOTHING',
        [m.id, m.name],
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
