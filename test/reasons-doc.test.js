/**
 * Issue #572 - pin the rejection reason table in docs/REASONS.md against the
 * registry in src/reasons.js.
 *
 * src/reasons.js is the source of truth for both reason codes and their
 * descriptions; docs/REASONS.md is the client-facing rendering of that same
 * data. Nothing today links the two, so a code added to (or dropped from)
 * either LOCAL_REASONS or UPSTREAM_REASONS can drift from the document a
 * buyer actually reads. This file parses the two markdown tables into code
 * sets and cross-checks them against the registry in both directions, and
 * asserts the Meaning cell text matches the registry description.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LOCAL_REASONS, UPSTREAM_REASONS } from '../src/reasons.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const reasonsDoc = readFileSync(join(ROOT, 'docs/REASONS.md'), 'utf8');

const normalize = s => s.replace(/\s+/g, ' ').trim();

/**
 * Parses a markdown table into [{ code, meaning }], skipping the header and
 * separator rows. Defensive about formatting: splits on `|`, trims cells,
 * and skips any row whose first cell isn't a backtick-quoted code.
 */
function parseTable(markdown) {
  const rows = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map(c => c.trim());
    if (cells.length < 2) continue;
    const codeMatch = cells[0].match(/^`([^`]+)`$/);
    if (!codeMatch) continue;
    rows.push({ code: codeMatch[1], meaning: normalize(cells[1]) });
  }
  return rows;
}

const sections = reasonsDoc.split(/^## /m);
const localSection = sections.find(s => s.startsWith('Local Transport Reasons'));
const upstreamSection = sections.find(s => s.startsWith('Upstream Scheme Reasons'));

assert.ok(localSection, 'docs/REASONS.md must have a "Local Transport Reasons" section');
assert.ok(upstreamSection, 'docs/REASONS.md must have an "Upstream Scheme Reasons" section');

const localRows = parseTable(localSection);
const upstreamRows = parseTable(upstreamSection);

test('every LOCAL_REASONS key has exactly one row in the Local Transport table', () => {
  for (const code of Object.keys(LOCAL_REASONS)) {
    const matches = localRows.filter(r => r.code === code);
    assert.equal(
      matches.length,
      1,
      `expected exactly one row for "${code}" in the Local Transport table, found ${matches.length}`,
    );
  }
});

test('every UPSTREAM_REASONS key has exactly one row in the Upstream Scheme table', () => {
  for (const code of Object.keys(UPSTREAM_REASONS)) {
    const matches = upstreamRows.filter(r => r.code === code);
    assert.equal(
      matches.length,
      1,
      `expected exactly one row for "${code}" in the Upstream Scheme table, found ${matches.length}`,
    );
  }
});

test('every row in the Local Transport table names a code in LOCAL_REASONS', () => {
  for (const { code } of localRows) {
    assert.ok(
      code in LOCAL_REASONS,
      `docs/REASONS.md documents "${code}" in the Local Transport table, but it is not in LOCAL_REASONS`,
    );
  }
});

test('every row in the Upstream Scheme table names a code in UPSTREAM_REASONS', () => {
  for (const { code } of upstreamRows) {
    assert.ok(
      code in UPSTREAM_REASONS,
      `docs/REASONS.md documents "${code}" in the Upstream Scheme table, but it is not in UPSTREAM_REASONS`,
    );
  }
});

test('the two tables document disjoint sets of codes', () => {
  const localCodes = new Set(localRows.map(r => r.code));
  const shared = upstreamRows.map(r => r.code).filter(code => localCodes.has(code));
  assert.deepEqual(
    shared,
    [],
    `codes documented in both the Local Transport and Upstream Scheme tables: ${shared.join(', ')}`,
  );
});

test('every Meaning cell matches the registry description, whitespace normalised', () => {
  const allRows = [...localRows, ...upstreamRows];
  const registry = { ...LOCAL_REASONS, ...UPSTREAM_REASONS };
  for (const { code, meaning } of allRows) {
    const expected = normalize(registry[code]);
    assert.equal(
      meaning,
      expected,
      `docs/REASONS.md Meaning cell for "${code}" does not match src/reasons.js:\n  doc:      ${meaning}\n  registry: ${expected}`,
    );
  }
});
