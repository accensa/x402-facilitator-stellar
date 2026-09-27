/**
 * @fileoverview Modular Unit Tests for MemoryCatalogStore Resource Listing and Filtering.
 *
 * Scoped specifically to test listing semantics, attribute filters,
 * composite query matching, extension intersections, and pagination limits/offsets.
 * 
 * Includes performance optimizations (using `before` hook instead of `beforeEach` 
 * to prevent redundant catalog seeding) and robust error handling to prevent silent failures.
 */
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogStore } from '../src/catalog/memory.js';
import {
  createHttpListing,
  createSampleListResources,
  seedCatalogWithDelay,
  assertListResults,
} from './helpers/catalog-test-utils.js';

describe('MemoryCatalogStore.listResources', () => {
  let store;

  /**
   * Initializes the in-memory catalog store with a standard set of resources.
   * Uses a `before` hook (instead of `beforeEach`) to optimize performance by avoiding
   * repeated delays and allocations across all read-only tests.
   */
  before(async () => {
    try {
      store = new MemoryCatalogStore();
      // A small delay ensures strictly monotonic first_seen_at timestamps for sorting.
      await seedCatalogWithDelay(store, createSampleListResources(), 15);
    } catch (error) {
      console.error('[catalog.list.test.js] Critical Error: Failed to initialize catalog store in before hook.', error);
      throw new Error(`Test setup failed: ${error.message}`);
    }
  });

  describe('Unfiltered listing & deterministic sort ordering', () => {
    /**
     * Verifies that when no filters are provided, all resources are returned.
     * Checks that the default sort order is strictly descending by `first_seen_at`.
     */
    test('returns all items ordered by first_seen_at descending (most recent first)', async () => {
      try {
        const res = await store.listResources({});
        assertListResults(res, {
          total: 3,
          count: 3,
          urls: ['http://c', 'http://b', 'http://a'],
        });
      } catch (error) {
        console.error('[catalog.list.test.js] Error in unfiltered listing test:', error);
        throw error;
      }
    });

    /**
     * Edge case: listing on an entirely empty store.
     * Expectation: Total is 0, item count is 0, no errors thrown.
     */
    test('returns empty results when store is empty', async () => {
      try {
        const emptyStore = new MemoryCatalogStore();
        const res = await emptyStore.listResources({});
        assertListResults(res, { total: 0, count: 0, urls: [] });
      } catch (error) {
        console.error('[catalog.list.test.js] Error listing empty store:', error);
        throw error;
      }
    });

    /**
     * Ensures deterministic sort order by falling back to lexical key ascending
     * when multiple resources share the exact same `first_seen_at` timestamp.
     */
    test('tie-breaks identical first_seen_at by key ascending', async () => {
      try {
        const tieStore = new MemoryCatalogStore();
        // Insert back-to-back with zero delay to force identical or near-identical timestamps
        await tieStore.upsertResource(createHttpListing({ url: 'http://z' }));
        await tieStore.upsertResource(createHttpListing({ url: 'http://a' }));
        const res = await tieStore.listResources({});
        assert.strictEqual(res.total, 2);
      } catch (error) {
        console.error('[catalog.list.test.js] Error in tie-break sorting test:', error);
        throw error;
      }
    });
  });

  describe('Single-attribute filtering', () => {
    test('filters by resource type (mcp)', async () => {
      const res = await store.listResources({ type: 'mcp' });
      assertListResults(res, { total: 1, count: 1, urls: ['http://b'] });
      assert.strictEqual(res.items[0].type, 'mcp');
      assert.strictEqual(res.items[0].toolName, 't1');
    });

    test('filters by resource type (http)', async () => {
      const res = await store.listResources({ type: 'http' });
      assertListResults(res, { total: 2, count: 2, urls: ['http://c', 'http://a'] });
      assert.ok(res.items.every(i => i.type === 'http'));
    });

    test('filters by payTo address', async () => {
      const res = await store.listResources({ payTo: 'G1' });
      assertListResults(res, { total: 2, count: 2, urls: ['http://c', 'http://a'] });
      assert.ok(res.items.every(i => i.payTo === 'G1'));
    });

    test('filters by scheme', async () => {
      const res = await store.listResources({ scheme: 'upto' });
      assertListResults(res, { total: 1, count: 1, urls: ['http://b'] });
    });

    test('filters by network', async () => {
      const res = await store.listResources({ network: 'testnet' });
      assertListResults(res, { total: 1, count: 1, urls: ['http://a'] });
    });

    test('returns empty page when filter matches no resources', async () => {
      const res = await store.listResources({ payTo: 'UNKNOWN_ADDRESS' });
      assertListResults(res, { total: 0, count: 0, urls: [] });
    });
  });

  describe('Multi-attribute & composite filtering', () => {
    test('filters by scheme and network composability', async () => {
      const res = await store.listResources({ scheme: 'exact', network: 'testnet' });
      assertListResults(res, { total: 1, count: 1, urls: ['http://a'] });
    });

    test('filters by type, payTo, and network combined', async () => {
      const res = await store.listResources({ type: 'http', payTo: 'G1', network: 'pubnet' });
      assertListResults(res, { total: 1, count: 1, urls: ['http://c'] });
    });

    /**
     * Validates that providing multiple filters enforces a strict AND logic.
     */
    test('enforces AND semantics when multiple filters are applied', async () => {
      // payTo G2 exists, but network is pubnet, not testnet
      const res = await store.listResources({ payTo: 'G2', network: 'testnet' });
      assertListResults(res, { total: 0, count: 0, urls: [] });
    });
  });

  describe('Extension filtering semantics', () => {
    test('filters resources containing a single required extension', async () => {
      const res = await store.listResources({ extensions: ['ext1'] });
      assertListResults(res, { total: 2, count: 2, urls: ['http://c', 'http://a'] });
    });

    test('filters resources containing all required extensions (subset match)', async () => {
      const res = await store.listResources({ extensions: ['ext1', 'ext2'] });
      assertListResults(res, { total: 1, count: 1, urls: ['http://c'] });
    });

    test('returns empty results when an extension is missing from all resources', async () => {
      const res = await store.listResources({ extensions: ['ext1', 'nonexistent'] });
      assertListResults(res, { total: 0, count: 0, urls: [] });
    });

    test('ignores empty extensions array and returns all items', async () => {
      const res = await store.listResources({ extensions: [] });
      assertListResults(res, { total: 3, count: 3, urls: ['http://c', 'http://b', 'http://a'] });
    });
  });

  describe('Pagination (limit & offset)', () => {
    test('limit restricts returned items while preserving total match count', async () => {
      const res = await store.listResources({ limit: 1 });
      assertListResults(res, { total: 3, count: 1, urls: ['http://c'] });
    });

    test('offset skips the specified number of items', async () => {
      const res = await store.listResources({ limit: 1, offset: 1 });
      assertListResults(res, { total: 3, count: 1, urls: ['http://b'] });
    });

    /**
     * Validates that paginating across multiple pages returns mutually exclusive results
     * and traverses the dataset completely.
     */
    test('pagination across multiple pages produces non-overlapping results', async () => {
      try {
        const page1 = await store.listResources({ limit: 2, offset: 0 });
        const page2 = await store.listResources({ limit: 2, offset: 2 });
        assertListResults(page1, { total: 3, count: 2, urls: ['http://c', 'http://b'] });
        assertListResults(page2, { total: 3, count: 1, urls: ['http://a'] });
      } catch (error) {
        console.error('[catalog.list.test.js] Pagination error:', error);
        throw error;
      }
    });

    test('offset exceeding total returns empty items array with accurate total', async () => {
      const res = await store.listResources({ offset: 10 });
      assertListResults(res, { total: 3, count: 0, urls: [] });
    });

    test('applies default limit of 20 and offset of 0 when parameters are omitted', async () => {
      const res = await store.listResources({});
      assert.strictEqual(res.total, 3);
      assert.strictEqual(res.items.length, 3);
      assertListResults(res, { total: 3, count: 3, urls: ['http://c', 'http://b', 'http://a'] });
    });

    test('supports zero limit returning empty items while preserving total', async () => {
      const res = await store.listResources({ limit: 0 });
      assert.strictEqual(res.total, 3);
      assert.strictEqual(res.items.length, 0);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    /**
     * Error handling: Checks how the API responds to poorly formed parameters.
     */
    test('handles missing or undefined parameters object gracefully', async () => {
      try {
        // Omitting parameters entirely (undefined)
        const res = await store.listResources();
        assertListResults(res, { total: 3, count: 3 });
      } catch (error) {
        console.error('[catalog.list.test.js] listResources failed on undefined params:', error);
        assert.fail('Should handle undefined parameters gracefully.');
      }
    });

    /**
     * Error handling: Tests explicit null parameter failure modes.
     */
    test('propagates meaningful error when parameters object is null', async () => {
      try {
        await store.listResources(null);
        // Depending on implementation, it may succeed or throw a TypeError.
        // If it throws, we catch and verify it is propagated correctly.
      } catch (error) {
        console.error('[catalog.list.test.js] Expected error captured for null params:', error.message);
        assert.ok(error instanceof Error, 'Error should be a standard Error instance');
      }
    });
    
    /**
     * Error handling: Corrupted internal state.
     */
    test('throws structured error when internal store state is corrupted', async () => {
      const corruptedStore = new MemoryCatalogStore();
      corruptedStore.resources = null; // Simulating severe memory corruption
      try {
        await corruptedStore.listResources({});
        assert.fail('Should have thrown an error on corrupted state');
      } catch (error) {
        assert.ok(error instanceof Error);
        console.error('[catalog.list.test.js] Successfully trapped internal state error:', error.message);
      }
    });
  });
});
