/**
 * The .sql blind spot in scripts/db-migrate.js (#500).
 *
 * The discovery filter listed only `.js` files, so `up`/`status` never saw
 * the six legacy `.sql` files next to them — and `status` printed
 * 'All migrations are up to date' for a database that never received them.
 * On top of that, `seed-legacy` recorded `003_rate_limit_buckets`, which does
 * not exist on disk (the file is `002_rate_limit_buckets.sql`), and omitted
 * the other three `.sql` files entirely.
 *
 * These tests pin the fix without needing a database: the runner enumerates
 * the `.sql` set, refuses `up` while any of it is untracked, reports it from
 * `status` instead of claiming to be up to date, and seeds exactly the stems
 * on disk. The duplicate stems (001_bazaar_catalog, 002_idempotency_keys) and
 * the 002_rate_limit_buckets.sql / 003_rate_limit_buckets.js collision resolve
 * to one defined ordering — lexicographic by filename — that the pending and
 * untracked helpers below share with `up`, `down` and `status`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_MIGRATIONS,
  findPendingJs,
  findUntrackedLegacy,
  listMigrationFiles,
  listSqlMigrationFiles,
} from '../scripts/db-migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const EXPECTED_SQL = [
  '001_bazaar_catalog.sql',
  '002_idempotency_keys.sql',
  '002_rate_limit_buckets.sql',
  '003_settlement_store.sql',
  '004_outbox_events.sql',
  '004_settlement_events.sql',
];

test('the six legacy .sql files sit next to the .js set', async () => {
  const entries = await readdir(MIGRATIONS_DIR);
  assert.deepEqual(entries.filter(f => f.endsWith('.sql')).sort(), EXPECTED_SQL);
});

test('the runner enumerates the .sql set instead of filtering to .js only', async () => {
  assert.deepEqual(await listSqlMigrationFiles(), EXPECTED_SQL);
  const js = await listMigrationFiles();
  assert.ok(js.length > 0, 'expected the .js set to still be listed');
  assert.ok(
    js.every(f => f.endsWith('.js')),
    'the .js listing must not leak .sql files',
  );
});

test('seed-legacy records exactly the .sql stems on disk', () => {
  const names = LEGACY_MIGRATIONS.map(m => m.name);
  assert.deepEqual(
    names,
    EXPECTED_SQL.map(f => f.replace(/\.sql$/, '')),
  );
  assert.ok(!names.includes('003_rate_limit_buckets'), 'the non-existent stem must be gone');
  assert.ok(names.includes('002_rate_limit_buckets'), 'the on-disk stem must be seeded');
  assert.equal(new Set(names).size, names.length, 'seed names must be unique (idempotent)');
});

test('untracked legacy is empty only when every .sql stem is recorded', () => {
  assert.deepEqual(findUntrackedLegacy(new Set(), EXPECTED_SQL), EXPECTED_SQL);
  const recorded = new Set(EXPECTED_SQL.map(f => f.replace(/\.sql$/, '')));
  assert.deepEqual(findUntrackedLegacy(recorded, EXPECTED_SQL), []);
  const partial = new Set(['001_bazaar_catalog']);
  assert.deepEqual(findUntrackedLegacy(partial, EXPECTED_SQL), EXPECTED_SQL.slice(1));
});

test('pending .js and untracked .sql share one defined filename ordering', async () => {
  const js = await listMigrationFiles();
  const sorted = [...js].sort();
  assert.deepEqual(js, sorted, '.js files must be in lexicographic filename order');
  assert.deepEqual(await listSqlMigrationFiles(), EXPECTED_SQL, '.sql files likewise');
  // A tracked 001_bazaar_catalog stem clears the .js pending entry while the
  // same-stem .sql stays an independent psql-path row: duplicates do not
  // double-apply through the runner.
  const applied = new Set(['001_bazaar_catalog']);
  assert.ok(!findPendingJs(applied, js).includes('001_bazaar_catalog.js'));
  assert.deepEqual(findUntrackedLegacy(applied, EXPECTED_SQL)[0], '002_idempotency_keys.sql');
});

test('status names ignored .sql files and up refuses while any is untracked', async () => {
  const source = await readFile(join(__dirname, '..', 'scripts', 'db-migrate.js'), 'utf8');
  assert.match(source, /Legacy SQL migrations/, 'status must report the ignored .sql files');
  assert.match(
    source,
    /Refusing to apply \.js migrations/,
    'up must refuse to start with the untracked .sql list',
  );
  assert.match(
    source,
    /untrackedLegacy\.length === 0/,
    "the 'up to date' claim must be gated on zero untracked legacy files",
  );
});
