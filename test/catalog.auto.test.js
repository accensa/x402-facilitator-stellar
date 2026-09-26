/**
 * @file catalog.auto.test.js
 * @description Tests for the MemoryCatalogStore auto-cataloging behavior:
 *   - Per-payTo resource cap enforcement (#186)
 *   - Update/upsert semantics at the cap boundary
 *   - payTo change warnings
 *   - Provenance and provisional listing lifecycle (#140)
 *
 * All tests are offline and require no network or funded accounts.
 * Error states are explicitly caught and asserted so failures surface with
 * a meaningful diagnostic rather than an unhandled rejection.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryCatalogStore,
  MAX_RESOURCES_PER_PAYTO_CODE,
  CatalogError,
} from '../src/catalog/memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fills a MemoryCatalogStore with `count` resources all owned by `payTo`.
 * Returns the populated store so tests can continue from the full state.
 *
 * @param {MemoryCatalogStore} store - The catalog store to populate.
 * @param {string} payTo - Stellar address owning all inserted resources.
 * @param {number} count - Number of resources to insert.
 * @returns {Promise<MemoryCatalogStore>} The same store after all upserts.
 */
async function fillStore(store, payTo, count) {
  for (let i = 0; i < count; i++) {
    await store.upsertResource({ url: `http://example.com/${i}`, payTo });
  }
  return store;
}

/**
 * Captures console.warn output during an async operation.
 * Restores the original console.warn even if the callback throws.
 *
 * @param {() => Promise<void>} fn - Async callback to execute while capturing.
 * @returns {Promise<string[]>} Array of warning messages emitted during `fn`.
 */
async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fn();
  } finally {
    // Always restore — even when the callback throws — so a test failure
    // does not poison the console for subsequent tests.
    console.warn = original;
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Suite: store limits
// ---------------------------------------------------------------------------

test('Auto Cataloging Store Limits', async t => {
  const store = new MemoryCatalogStore();

  await t.test('Enforces 50 resources per payTo', async () => {
    await fillStore(store, 'G123', 50);

    // The 51st upsert must reject with the stable reason code so callers can
    // distinguish this error from unexpected failures.
    await assert.rejects(
      store.upsertResource({ url: 'http://example.com/50', payTo: 'G123' }),
      err => {
        assert.ok(
          err instanceof CatalogError,
          `expected CatalogError, got ${err?.constructor?.name}: ${err?.message}`,
        );
        assert.equal(
          err.code,
          MAX_RESOURCES_PER_PAYTO_CODE,
          `expected code ${MAX_RESOURCES_PER_PAYTO_CODE}, got ${err.code}`,
        );
        return true;
      },
    );
  });

  await t.test('Allows updates to existing resources even if at limit', async () => {
    // Updating an existing URL must not throw — the cap applies only to
    // *new* entries, so an update at the limit must always succeed.
    await assert.doesNotReject(
      store.upsertResource({ url: 'http://example.com/0', payTo: 'G123', serviceName: 'Updated' }),
      'upsert of an existing resource at the cap limit should not throw',
    );
  });

  await t.test('Warns on payTo change', async () => {
    const warnings = await captureWarnings(async () => {
      await store.upsertResource({ url: 'http://example.com/0', payTo: 'G456' });
    });

    assert.ok(
      warnings.length > 0,
      'expected at least one console.warn call when payTo changes, got none',
    );
    assert.ok(
      warnings.some(w => w.includes('changed payTo from G123 to G456')),
      `expected warning about payTo change, got: ${JSON.stringify(warnings)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: provenance and provisional lifecycle (#140)
// ---------------------------------------------------------------------------

describe('Catalog provenance and provisional lifecycle (#140)', () => {
  /**
   * A listing created by a verify-source upsert starts provisional (has an
   * expiry, is visible but not permanent). A subsequent settle promotes it
   * to a permanent listing with no expiry.
   */
  test('a verify-source upsert is provisional and expiring; a settle promotes it', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 60_000 });

    await store.upsertResource({ url: 'http://p.ex/1', payTo: 'G1' }, 'verify');
    let entry = await store.getResource('http://p.ex/1');

    assert.equal(entry.source, 'verify', 'source should be "verify" after verify-upsert');
    assert.equal(entry.provisional, true, 'entry should be provisional after verify-upsert');
    assert.ok(entry.expires_at != null, 'provisional entry should have a non-null expires_at');

    // Still discoverable before expiry.
    const { total } = await store.listResources({});
    assert.equal(total, 1, 'provisional (non-expired) entry should appear in listResources');

    // Settle promotes the entry.
    await store.upsertResource({ url: 'http://p.ex/1', payTo: 'G1' }, 'settle');
    entry = await store.getResource('http://p.ex/1');

    assert.equal(entry.source, 'settle', 'source should be "settle" after settle-upsert');
    assert.equal(entry.provisional, false, 'entry should not be provisional after settle');
    assert.equal(entry.expires_at, null, 'settled entry should have null expires_at');
  });

  /**
   * A settle that lands on an already-expired provisional entry should still
   * promote it: the semantics are "real payment happened" regardless of timing.
   */
  test('a settle landing on an old provisional entry promotes it and clears expiry', async () => {
    // catalogVerifyTtlMs: -1 makes the entry immediately expired on creation.
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: -1 });
    await store.upsertResource({ url: 'http://p.ex/2', payTo: 'G1' }, 'verify');
    await store.upsertResource({ url: 'http://p.ex/2', payTo: 'G1' }, 'settle');

    const entry = await store.getResource('http://p.ex/2');
    assert.equal(entry.source, 'settle');
    assert.equal(entry.provisional, false);
    assert.equal(entry.expires_at, null);
  });

  /**
   * A verify that arrives after a settle must never overwrite the settled
   * state: verifies carry no proof of payment and must not demote a permanent
   * listing back to provisional.
   */
  test('a verify never demotes an already-settled listing', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 1_000_000 });
    await store.upsertResource({ url: 'http://p.ex/3', payTo: 'G1' }, 'settle');
    await store.upsertResource({ url: 'http://p.ex/3', payTo: 'G1' }, 'verify');

    const entry = await store.getResource('http://p.ex/3');
    assert.equal(entry.source, 'settle', 'verify after settle must not change source to "verify"');
    assert.equal(entry.provisional, false, 'verify after settle must not mark entry provisional');
    assert.equal(entry.expires_at, null, 'verify after settle must not set an expiry');
  });

  /**
   * Expired provisional listings must be hidden from listResources and
   * physically removed by pruneExpired. Settled entries at the same address
   * are unaffected.
   */
  test('expired provisional listings are hidden from discovery and pruned', async () => {
    // A 5 ms TTL lets us expire entries with a short sleep.
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });

    await store.upsertResource({ url: 'http://p.ex/4', payTo: 'G1' }, 'verify');
    await store.upsertResource({ url: 'http://p.ex/4', payTo: 'G1' }, 'settle');
    await store.upsertResource({ url: 'http://e.ex/4', payTo: 'G2' }, 'verify');

    // Both entries visible before expiry.
    assert.equal(
      (await store.listResources({})).total,
      2,
      'both entries should be visible before expiry',
    );

    // Wait for the verify-only entry to expire.
    await new Promise(r => setTimeout(r, 20));

    // The expired verify-only entry is hidden; the settled one stays public.
    const afterExpiry = await store.listResources({});
    assert.equal(
      afterExpiry.total,
      1,
      'expired provisional entry should be hidden from listResources',
    );

    // pruneExpired physically removes the expired entry.
    const pruned = await store.pruneExpired();
    assert.equal(pruned, 1, 'pruneExpired should report 1 removed entry');
    assert.equal(
      (await store.listResources({})).total,
      1,
      'listResources should still return 1 after pruning',
    );
  });
});
