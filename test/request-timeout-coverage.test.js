/**
 * REQUEST_TIMEOUT_MS bounds every catalog read (#671).
 *
 * /verify and /settle already raced their collaborator against the budget;
 * GET /discovery/resources and GET /discovery/search awaited the store with no
 * deadline at all, so a slow store held the socket past the advertised budget.
 * These tests hand the app a catalog whose read never settles and assert the
 * route answers `internal_error` promptly, with one log line naming it.
 *
 * The never-resolving stub is the point: on the pre-#671 code the request
 * hangs, so this file cannot pass without the deadline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve, testConfig, stubCatalog, never } from './helpers/app.js';

const TIMEOUT_MS = 25;

/**
 * Drives one catalog route against a never-settling store and asserts the
 * response is bounded by the per-request budget.
 */
async function assertCatalogReadIsBounded(t, { path, route, catalog }) {
  const logged = [];
  t.mock.method(console, 'error', (...args) => {
    logged.push(args.map(String).join(' '));
  });

  const app = await serve({
    config: { ...testConfig(), requestTimeoutMs: TIMEOUT_MS },
    catalog,
  });
  try {
    const startedAt = Date.now();
    const res = await app.get(path);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(res.status, 500);
    // The catalog path keeps its own shape: never SUBMITTED_OUTCOME_UNKNOWN,
    // which is reserved for a settlement whose submission is in doubt.
    assert.deepEqual(await res.json(), { error: 'internal_error', reason: 'internal_error' });
    assert.ok(
      elapsedMs < 1_000,
      `expected ${route} to answer within the ${TIMEOUT_MS}ms budget, waited ${elapsedMs}ms`,
    );
    assert.ok(
      logged.some(line => line.includes(route)),
      `expected one log line naming ${route}, got ${JSON.stringify(logged)}`,
    );
  } finally {
    await app.close();
  }
}

test(
  'GET /discovery/resources answers within REQUEST_TIMEOUT_MS when the store never settles (#671)',
  { timeout: 5_000 },
  async t => {
    await assertCatalogReadIsBounded(t, {
      path: '/discovery/resources',
      route: '/discovery/resources',
      catalog: stubCatalog({ listResources: never }),
    });
  },
);

test(
  'GET /discovery/search answers within REQUEST_TIMEOUT_MS when the store never settles (#671)',
  { timeout: 5_000 },
  async t => {
    await assertCatalogReadIsBounded(t, {
      path: '/discovery/search?query=widget',
      route: '/discovery/search',
      catalog: stubCatalog({ search: never }),
    });
  },
);
