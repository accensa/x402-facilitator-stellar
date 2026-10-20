import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function read(file) {
  return readFileSync(path.join(repoRoot, file), 'utf8');
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let current = '';
  let parenDepth = 0;
  let braceDepth = 0;
  for (const ch of text) {
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (ch === delimiter && parenDepth === 0 && braceDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseRuntimeColumns(sql) {
  const match = sql.match(
    /CREATE TABLE IF NOT EXISTS catalog_resources\s*\(([\s\S]*?)\);\s*CREATE INDEX IF NOT EXISTS/i,
  );
  assert.ok(match, 'runtime schema definition is missing CREATE TABLE catalog_resources');

  const columns = {};
  for (const chunk of splitTopLevel(match[1], ',')) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed.startsWith('CONSTRAINT')) continue;

    const columnMatch = trimmed.match(/^([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+(?:\([^)]*\))?)\s*(.*)$/);
    assert.ok(columnMatch, `could not parse runtime column: ${trimmed}`);

    const [, name, type, rest = ''] = columnMatch;
    const normalizedRest = rest.trim();
    const notNull = /NOT NULL/i.test(normalizedRest);
    const defaultMatch = normalizedRest.match(/DEFAULT\s+(.+)$/i);
    columns[name] = {
      type: type.toUpperCase(),
      notNull,
      default: defaultMatch ? defaultMatch[1].trim().replace(/['"`]/g, '') : null,
    };
  }
  return columns;
}

function parseMigrationColumns(sql) {
  const match = sql.match(/pgm\.createTable\('catalog_resources',\s*\{([\s\S]*?)\}\);/);
  assert.ok(match, 'migration schema definition is missing pgm.createTable("catalog_resources")');

  const body = match[1];
  const columns = {};
  for (const chunk of splitTopLevel(body, ',')) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed.startsWith('pgm.')) continue;

    const columnMatch = trimmed.match(/^([A-Za-z0-9_]+):\s*\{\s*([\s\S]*?)\s*\}\s*$/);
    assert.ok(columnMatch, `could not parse migration column: ${trimmed}`);

    const [, name, details] = columnMatch;
    const typeMatch = details.match(/type:\s*'([^']+)'/);
    const notNullMatch = details.match(/notNull:\s*(true|false)/);
    const defaultMatch = details.match(/default:\s*([^,}]+)/);

    columns[name] = {
      type: typeMatch ? typeMatch[1].toUpperCase() : null,
      notNull: notNullMatch ? notNullMatch[1] === 'true' : false,
      default: defaultMatch ? defaultMatch[1].trim().replace(/['"`]/g, '') : null,
    };
  }
  return columns;
}

function parseRuntimeIndexes(sql) {
  return new Set(
    [
      ...sql.matchAll(
        /CREATE INDEX IF NOT EXISTS\s+[A-Za-z0-9_]+\s+ON\s+catalog_resources\s*\(([^)]+)\);/gi,
      ),
    ].map(([, columns]) => columns.replace(/\s+/g, ' ').trim()),
  );
}

function parseMigrationIndexes(sql) {
  return new Set(
    [...sql.matchAll(/pgm\.createIndex\('catalog_resources',\s*'([A-Za-z0-9_]+)'\);/g)].map(
      ([, column]) => column,
    ),
  );
}

test('catalog schema parity matches runtime and migration definitions', () => {
  const runtimeSql = read('src/catalog/postgres.js');
  const migrationSql = read('migrations/006_catalog_resources.js');

  const runtimeColumns = parseRuntimeColumns(runtimeSql);
  const migrationColumns = parseMigrationColumns(migrationSql);
  const runtimeIndexes = parseRuntimeIndexes(runtimeSql);
  const migrationIndexes = parseMigrationIndexes(migrationSql);

  assert.deepEqual(
    Object.keys(runtimeColumns).sort(),
    Object.keys(migrationColumns).sort(),
    'same columns must exist in both schema definitions',
  );

  for (const name of Object.keys(runtimeColumns)) {
    assert.deepEqual(
      runtimeColumns[name],
      migrationColumns[name],
      `column ${name} must match between runtime and migration definitions`,
    );
  }

  assert.deepEqual(
    [...runtimeIndexes].sort(),
    [...migrationIndexes].sort(),
    'index set must match between runtime and migration definitions',
  );
});
