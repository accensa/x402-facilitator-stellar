/**
 * Issue #575 honesty checks for the audit event inventory.
 *
 * docs/AUDIT.md is the published list of what the trail holds; the code is the
 * only authority on what it actually emits. Those two drifted: `dlq_replay` and
 * `dlq_discard` were emitted under src/ but had no row in the table, so an
 * auditor diffing the docs against the source found unexplained event types.
 *
 * This gate scans every JavaScript file under src/ for the narrow call shape
 * `audit('literal', ...)` and requires the set of literals to equal the table's
 * first column in both directions. A refactor that stops using a string literal
 * here (or moves emit sites out of the named directories) makes the mismatch
 * visible instead of silently passing an empty scan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Source trees searched for audit call literals; subdirectories included. */
const SCANNED_DIRECTORIES = ['src'];

const EVENT_CALL = /\baudit\(\s*'([a-z][a-z0-9_]*)'/g;
const TABLE_ROW = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm;

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function javascriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...javascriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}

/** Comment examples are documentation, not emit sites. */
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/** Every event-name literal passed to an audit(...) call under src/. */
function auditEventsEmitted() {
  const events = new Set();
  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of javascriptFiles(join(ROOT, directory))) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (isCommentLine(line)) continue;
        for (const match of line.matchAll(EVENT_CALL)) events.add(match[1]);
      }
    }
  }
  return events;
}

/** Every event name in the first column of the AUDIT.md inventory table. */
function auditEventsDocumented() {
  const doc = read('docs/AUDIT.md');
  const start = doc.indexOf('### What is audited, and why');
  assert.notEqual(start, -1, 'docs/AUDIT.md must keep the "What is audited, and why" section');

  const section = doc.slice(start);
  const nextHeading = section.indexOf('\n### ', 1);
  const table = nextHeading === -1 ? section : section.slice(0, nextHeading);
  return new Set([...table.matchAll(TABLE_ROW)].map(match => match[1]));
}

test('every audit event emitted under src/ has a documented row', () => {
  const emitted = auditEventsEmitted();
  const documented = auditEventsDocumented();

  assert.ok(
    emitted.size > 0,
    'the source scan found no audit(...) literals; the call style or scanned directories changed',
  );

  const undocumented = [...emitted].filter(event => !documented.has(event)).sort();
  const stale = [...documented].filter(event => !emitted.has(event)).sort();

  assert.deepEqual(
    undocumented,
    [],
    `audit events emitted by src/ but missing from docs/AUDIT.md: ${undocumented.join(', ')}`,
  );
  assert.deepEqual(
    stale,
    [],
    `docs/AUDIT.md rows with no audit(...) literal under src/: ${stale.join(', ')}`,
  );
});

test('the DLQ admin actions are documented with the fields their emit sites carry', () => {
  const doc = read('docs/AUDIT.md');
  const routes = read('src/dlq/routes.js');

  for (const event of ['dlq_replay', 'dlq_discard']) {
    assert.ok(doc.includes(`| \`${event}\` |`), `docs/AUDIT.md must document ${event}`);
    assert.ok(routes.includes(`audit('${event}'`), `src/dlq/routes.js must still emit ${event}`);
  }

  const rows = new Map(
    doc
      .split('\n')
      .filter(line => /^\| `dlq_(?:replay|discard)` \|/.test(line))
      .map(line => [line.match(/`(dlq_[a-z]+)`/)[1], line]),
  );

  for (const event of ['dlq_replay', 'dlq_discard']) {
    for (const field of ['actor', 'dead-letter', 'message']) {
      assert.match(rows.get(event), new RegExp(field, 'i'), `${event} row must name ${field}`);
    }
  }
  assert.match(rows.get('dlq_replay'), /delivered.*failed|failed.*delivered/);

  for (const field of ['actor', 'dead_letter_id', 'message_id']) {
    assert.ok(routes.includes(field), `src/dlq/routes.js emit sites must still carry ${field}`);
  }
  assert.match(routes, /result\.delivered \? 'delivered' : 'failed'/);
});

test('docs/PRIVACY.md still points retention at docs/AUDIT.md', () => {
  const privacy = read('docs/PRIVACY.md');
  assert.match(privacy, /Audit Records.*see docs\/AUDIT\.md/s);
  assert.match(privacy, /settlements follow the settlement-record class/);
  assert.match(privacy, /all other audit records follow the request-log class/);
});
