/**
 * Keeps docs/MIGRATIONS.md honest about the migrations/ tree (issue #739).
 *
 * The guide used to print an ordering example naming a `003` rate-limit
 * migration that does not exist on disk, and said nothing about the duplicate
 * numeric prefixes (001/002/004 exist as both `.js` and `.sql`). A developer
 * following it would look for the wrong file and miss that `.js` and `.sql`
 * are separate, separately ordered sets.
 *
 * This test extracts the file listing from the guide and requires it to match
 * the real directory in both directions, so the next added or renamed
 * migration either updates the document or fails CI.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = join(ROOT, 'docs/MIGRATIONS.md');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

/** The document text, read once per test. */
function readDoc() {
  return readFileSync(DOC_PATH, 'utf8');
}

/**
 * The fenced listing under "Creating a new migration": a `migrations/` block
 * whose lines are migration filenames, optionally followed by a `#` comment.
 * Returns the listed basenames, excluding the explicitly illustrative entry
 * (`20260826000000_your_change.js  # example only`), which is not a real file.
 */
function documentedMigrationFiles() {
  const doc = readDoc();
  const block = doc.match(/```\nmigrations\/\n([\s\S]*?)```/);
  assert.ok(block, 'docs/MIGRATIONS.md must contain a fenced `migrations/` listing');

  const files = [];
  for (const raw of block[1].split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const [name, comment = ''] = line.split('#');
    const file = name.trim();
    if (!file) continue;
    // The timestamp example is a template for the reader's own migration, not
    // a file that should exist; it is marked as such in the document.
    if (/example only/i.test(comment)) continue;
    files.push(file);
  }
  return files;
}

/** Every real migration filename, `.js` and `.sql` alike. */
function actualMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js') || f.endsWith('.sql'))
    .sort();
}

test('every migration file listed in MIGRATIONS.md exists on disk', () => {
  const listed = documentedMigrationFiles();
  const actual = new Set(actualMigrationFiles());

  assert.ok(listed.length > 0, 'the migrations/ listing must not be empty');
  const missing = listed.filter(f => !actual.has(f));
  assert.deepEqual(
    missing,
    [],
    'docs/MIGRATIONS.md lists migration files that are not in migrations/ — update the listing',
  );
});

test('the migrations/ listing covers every file on disk', () => {
  const listed = new Set(documentedMigrationFiles());
  const missingFromDoc = actualMigrationFiles().filter(f => !listed.has(f));

  assert.deepEqual(
    missingFromDoc,
    [],
    'migrations/ contains files the guide does not list — add them so the ordering example ' +
      'stays an accurate picture of the tree',
  );
});

test('the listing separates the node-pg-migrate .js set from the legacy .sql set', () => {
  const listed = documentedMigrationFiles();

  assert.ok(
    listed.some(f => f.endsWith('.js')),
    'the listing must show the .js migrations the runner applies',
  );
  assert.ok(
    listed.some(f => f.endsWith('.sql')),
    'the listing must show the legacy .sql migrations the runner does not apply',
  );
});

test('duplicate numeric prefixes and ordering are explained, not left to inference', () => {
  const doc = readDoc();

  // The guide must say that numbering is not unique, and name the specific
  // 002/003 rate-limit collision that first exposed the drift.
  assert.match(doc, /not unique/i, 'the guide must warn that migration numbering is not unique');
  assert.match(
    doc,
    /duplicate/i,
    'the guide must explain duplicate numeric prefixes across the .js and .sql sets',
  );
  assert.match(
    doc,
    /002_rate_limit_buckets\.sql/,
    'the guide must name the legacy 002_rate_limit_buckets.sql file',
  );
  assert.match(
    doc,
    /003_rate_limit_buckets\.js/,
    'the guide must name the node-pg-migrate 003_rate_limit_buckets.js file',
  );

  // And the ordering rule itself: lexicographic, with a 14-digit timestamp
  // for new migrations.
  assert.match(
    doc,
    /lexicographic/i,
    'the guide must state that files are ordered lexicographically',
  );
  assert.match(doc, /14-digit/i, 'the guide must state the 14-digit timestamp convention');
  assert.match(doc, /20260826000000/, 'the guide must show a concrete 14-digit timestamp prefix');
});
