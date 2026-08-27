/**
 * Enforces docs/AUTHENTICATION.md's route inventory against the real app
 * (issue #145: "AUTHENTICATION.md's list of open routes omits both discovery
 * endpoints").
 *
 * The point of this test is that the *next* omission is a CI failure rather
 * than documentation drift: build the app from src/app.js, enumerate every
 * route Fastify actually registered, and require each one to appear in the
 * document's route-inventory table — and require every documented route to
 * exist in the app, so a typo cannot silently document a route that does not
 * exist.
 *
 * It also asserts the two specifics the issue called out: both discovery read
 * routes are documented as open, and /usage's strict (open-mode-refusing)
 * behaviour is documented.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { stubCatalog, stubFacilitator, stubRateLimiter, testConfig } from './helpers/app.js';

/** Enumerates `METHOD /path` for every route the app registers. */
function registeredRoutes() {
  const app = createApp(
    testConfig({ apiKeys: ['key_0:secret'] }),
    stubFacilitator(),
    stubRateLimiter(),
    stubCatalog(),
    undefined,
    {},
  );

  const tree = app.printRoutes({ commonPrefix: false });
  const routes = new Set();

  // The tree is indented one 4-char level per depth; a level is either four
  // spaces (non-last sibling) or "│   " (continuation under a parent). Track
  // the accumulated path per depth so a split segment like
  // "/settle" + "ments/:idempotencyKey" rejoins into "/settlements/...".
  const stack = [];
  for (const raw of tree.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;

    let depth = 0;
    let i = 0;
    while (i + 4 <= line.length) {
      const level = line.slice(i, i + 4);
      if (level === '    ' || level === '│   ') {
        depth += 1;
        i += 4;
      } else {
        break;
      }
    }

    const match = line.slice(i).match(/^[├└]──\s(.+)$/);
    if (!match) continue;

    const label = match[1];
    const paren = label.lastIndexOf(' (');
    const path = paren === -1 ? label : label.slice(0, paren);
    const methods = paren === -1 ? [] : label.slice(paren + 2, -1).split(', ');

    stack.length = depth;
    stack[depth] = path;
    const fullPath = stack.join('');

    for (const method of methods) {
      // Fastify auto-registers HEAD for every GET; the doc does not enumerate it.
      if (method === 'HEAD') continue;
      routes.add(`${method} ${fullPath}`);
    }
  }

  return routes;
}

/** Reads the route-inventory table rows out of the document. */
function documentedRoutes() {
  const doc = readFileSync(new URL('../docs/AUTHENTICATION.md', import.meta.url), 'utf8');
  const section = doc.split('## Route Inventory')[1] ?? '';
  const table = section.split('##')[0] ?? '';

  const routes = new Set();
  for (const line of table.split('\n')) {
    // Rows are backtick-quoted: `GET /healthz`. The path capture excludes the
    // closing backtick so it cannot be swallowed by the greedy `[^|]+`.
    const match = line.match(/^\|\s*`?(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/[^|`]+)`?\s*\|/);
    if (match) routes.add(`${match[1]} ${match[2].trim()}`);
  }
  return routes;
}

test('every route registered by src/app.js is documented in AUTHENTICATION.md', () => {
  const app = registeredRoutes();
  const doc = documentedRoutes();

  // The five OPTIONS preflights are documented as one row — `OPTIONS
  // <cors-enabled route>` — because they all share a posture. Accept that row
  // as covering each individual preflight.
  const section = readFileSync(new URL('../docs/AUTHENTICATION.md', import.meta.url), 'utf8');
  const coversPreflights = /`OPTIONS <cors-enabled route>`/.test(section);

  const missing = [...app].filter(route => {
    if (route.startsWith('OPTIONS ') && coversPreflights) return false;
    return !doc.has(route);
  });
  assert.deepEqual(
    missing,
    [],
    'Routes registered in app.js but missing from the AUTHENTICATION.md route inventory — ' +
      'add them to the table so the open surface is not under-reported',
  );
});

test('every route documented in AUTHENTICATION.md is registered by src/app.js', () => {
  const app = registeredRoutes();
  const doc = documentedRoutes();

  const phantom = [...doc].filter(route => !app.has(route));
  assert.deepEqual(
    phantom,
    [],
    'Routes documented in AUTHENTICATION.md but not registered by app.js — ' +
      'either the doc has a typo or the route was removed without updating the table',
  );
});

test('both discovery read routes are documented as open by design', () => {
  const doc = readFileSync(new URL('../docs/AUTHENTICATION.md', import.meta.url), 'utf8');
  const inventory = doc.split('## Route Inventory')[1] ?? '';

  for (const route of ['GET /discovery/resources', 'GET /discovery/search']) {
    const row = inventory.split('\n').find(line => line.includes(`| \`${route}\``));
    assert.ok(row, `no inventory row for ${route}`);
    assert.match(row, /open \*\*by design\*\*/, `${route} must be documented as open by design`);
  }
});

test("GET /usage's open-mode refusal is documented", () => {
  const doc = readFileSync(new URL('../docs/AUTHENTICATION.md', import.meta.url), 'utf8');

  assert.match(
    doc,
    /open_mode_usage_forbidden/,
    'the /usage open-mode refusal reason must be documented',
  );
  assert.match(
    doc,
    /strict/,
    'the doc must say that /usage uses the strict key check, distinct from requireApiKey',
  );
});
