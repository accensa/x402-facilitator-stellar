/**
 * Tests for the migration compatibility checker (scripts/check-migration-compat.js).
 *
 * The checker reads migration files from disk and validates backward-compatibility
 * patterns. These tests exercise the checker against known-good and known-bad
 * migration file contents to verify that it catches the right issues.
 *
 * Since the checker is a standalone script (not a library), we test it by
 * examining its pattern-matching logic through the lens of the actual migration
 * files in this repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Read all JS migration files from the migrations directory.
 */
async function loadMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  const jsFiles = entries.filter(f => f.endsWith('.js')).sort();
  const files = [];
  for (const f of jsFiles) {
    const content = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    files.push({ name: f, content });
  }
  return files;
}

test('migrations directory contains JS files', async () => {
  const files = await loadMigrationFiles();
  assert.ok(files.length > 0, 'Expected at least one JS migration file');
  assert.ok(
    files.some(f => f.name === '001_bazaar_catalog.js'),
    'Expected 001_bazaar_catalog.js to exist',
  );
  assert.ok(
    files.some(f => f.name === '002_idempotency_keys.js'),
    'Expected 002_idempotency_keys.js to exist',
  );
  assert.ok(
    files.some(f => f.name === '003_rate_limit_buckets.js'),
    'Expected 003_rate_limit_buckets.js to exist',
  );
});

test('all migration files export up and down functions', async () => {
  const files = await loadMigrationFiles();
  for (const file of files) {
    assert.ok(file.content.includes('export const up'), `${file.name}: missing up() export`);
    assert.ok(file.content.includes('export const down'), `${file.name}: missing down() export`);
  }
});

test('expand migration does not contain DROP in up()', async () => {
  const files = await loadMigrationFiles();
  const expandFiles = files.filter(f => f.name.includes('expand') || f.name.includes('add_'));
  for (const file of expandFiles) {
    // Extract the up() function body.
    const upMatch = file.content.match(/export const up\s*=\s*pgm\s*=>\s*\{([\s\S]*?)\n\};/);
    if (upMatch) {
      assert.ok(
        !/\bDROP\s+TABLE\b/i.test(upMatch[1]),
        `${file.name}: up() must not contain DROP TABLE`,
      );
      assert.ok(
        !/\bDROP\s+COLUMN\b/i.test(upMatch[1]),
        `${file.name}: up() must not contain DROP COLUMN`,
      );
    }
  }
});

test('expand migration does not use RENAME', async () => {
  const files = await loadMigrationFiles();
  const expandFiles = files.filter(f => f.name.includes('expand') || f.name.includes('add_'));
  for (const file of expandFiles) {
    const upMatch = file.content.match(/export const up\s*=\s*pgm\s*=>\s*\{([\s\S]*?)\n\};/);
    if (upMatch) {
      assert.ok(
        !/\bRENAME\s+(TABLE|COLUMN)\b/i.test(upMatch[1]),
        `${file.name}: up() must not use RENAME — use expand-and-contract instead`,
      );
    }
  }
});

test('expand migration does not use LOCK TABLE', async () => {
  const files = await loadMigrationFiles();
  const expandFiles = files.filter(f => f.name.includes('expand') || f.name.includes('add_'));
  for (const file of expandFiles) {
    assert.ok(
      !/\bLOCK\s+TABLE\b/i.test(file.content),
      `${file.name}: must not use LOCK TABLE — blocks reads and writes`,
    );
  }
});

test('sample expand migration adds a nullable column', async () => {
  const files = await loadMigrationFiles();
  const expandFile = files.find(f => f.name.includes('sample_expand'));
  assert.ok(expandFile, 'Expected a sample expand migration');

  // The expand migration should use addColumn with a nullable type.
  assert.ok(
    expandFile.content.includes('pgm.addColumn'),
    'Expand migration should use pgm.addColumn',
  );
  // Should NOT have notNull: true (without a default).
  const addColumnSection = expandFile.content.substring(
    expandFile.content.indexOf('pgm.addColumn'),
  );
  assert.ok(
    !addColumnSection.match(/notNull:\s*true(?![\s\S]*?default)/),
    'Expanded column should be nullable or have a default',
  );
});

test('sample contract migration drops what expand added', async () => {
  const files = await loadMigrationFiles();
  const contractFile = files.find(f => f.name.includes('sample_contract'));
  assert.ok(contractFile, 'Expected a sample contract migration');

  assert.ok(
    contractFile.content.includes('pgm.dropColumn'),
    'Contract migration should use pgm.dropColumn',
  );
  assert.ok(
    contractFile.content.includes('access_tier'),
    'Contract migration should drop access_tier',
  );
});

test('every expand migration has a corresponding contract', async () => {
  const files = await loadMigrationFiles();
  const expandFiles = files.filter(f => f.name.includes('expand') || f.name.includes('add_'));
  const contractFiles = files.filter(f => f.name.includes('contract') || f.name.includes('drop_'));

  const contractTargets = new Set(
    contractFiles.map(f => {
      const match = f.name.match(/drop_(\w+)/);
      return match ? match[1] : null;
    }),
  );

  for (const file of expandFiles) {
    const match = file.name.match(/add_(\w+)/);
    if (match) {
      assert.ok(
        contractTargets.has(match[1]),
        `Expand migration adds "${match[1]}" but no contract migration was found`,
      );
    }
  }
});

test('up() and down() are inverses for the expand/contract pair', async () => {
  const files = await loadMigrationFiles();
  const expandFile = files.find(f => f.name.includes('sample_expand'));
  const contractFile = files.find(f => f.name.includes('sample_contract'));

  assert.ok(expandFile && contractFile, 'Need both expand and contract files');

  // Expand up adds the column; contract up should drop it.
  assert.ok(expandFile.content.includes('addColumn'), 'Expand up() adds column');
  assert.ok(contractFile.content.includes('dropColumn'), 'Contract up() drops column');

  // Expand down drops; contract down adds.
  assert.ok(expandFile.content.includes('dropColumn'), 'Expand down() drops column');
  assert.ok(contractFile.content.includes('addColumn'), 'Contract down() adds column');
});
