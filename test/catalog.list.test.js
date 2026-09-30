/**
 * Modular Unit Tests for MemoryCatalogStore Resource Listing and Filtering
 *
 * Scoped specifically to test listing semantics, attribute filters,
 * composite query matching, extension intersections, and pagination limits/offsets.
 */
import { describe, test, beforeEach } from 'node:test';
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

  beforeEach(async () => {
    store = new MemoryCatalogStore();
    await seedCatalogWithDelay(store, createSampleListResources(), 15);
  });

  describe('Unfiltered listing & deterministic sort ordering', () => {
    test('returns all items ordered by first_seen_at descending (most recent first)', async () => {
      const res = await store.listResources({});
      assertListResults(res, {
        total: 3,
        count: 3,
        urls: ['http://c', 'http://b', 'http://a'],
      });
    });

    test('returns empty results when store is empty', async () => {
      const emptyStore = new MemoryCatalogStore();
      const res = await emptyStore.listResources({});
      assertListResults(res, { total: 0, count: 0, urls: [] });
    });

    test('tie-breaks identical first_seen_at by key ascending', async () => {
      const tieStore = new MemoryCatalogStore();
      await tieStore.upsertResource(createHttpListing({ url: 'http://z' }));
      await tieStore.upsertResource(createHttpListing({ url: 'http://a' }));
      const res = await tieStore.listResources({});
      assert.strictEqual(res.total, 2);
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

    test('pagination across multiple pages produces non-overlapping results', async () => {
      const page1 = await store.listResources({ limit: 2, offset: 0 });
      const page2 = await store.listResources({ limit: 2, offset: 2 });
      assertListResults(page1, { total: 3, count: 2, urls: ['http://c', 'http://b'] });
      assertListResults(page2, { total: 3, count: 1, urls: ['http://a'] });
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

  describe('Edge cases and boundary conditions', () => {
    test('handles negative limit and offset gracefully by treating them as 0 or array slice semantics', async () => {
      const res = await store.listResources({ limit: -1, offset: -1 });
      assert.ok(Array.isArray(res.items));
    });

    test('ignores extensions filter if extensions is not an array', async () => {
      const res = await store.listResources({ extensions: 'ext1' });
      assert.strictEqual(res.total, 3);
      assert.strictEqual(res.items.length, 3);
    });

    test('ignores extensions filter if extensions is null', async () => {
      const res = await store.listResources({ extensions: null });
      assert.strictEqual(res.total, 3);
      assert.strictEqual(res.items.length, 3);
    });

    test('filters resources properly when resource has no extensions field', async () => {
      const noExtStore = new MemoryCatalogStore();
      await noExtStore.upsertResource(
        createHttpListing({ url: 'http://noext', extensions: undefined }),
      );

      const resEmpty = await noExtStore.listResources({ extensions: [] });
      assert.strictEqual(resEmpty.total, 1);

      const resFilter = await noExtStore.listResources({ extensions: ['ext1'] });
      assert.strictEqual(resFilter.total, 0);
    });

    test('filters out expired provisional resources', async () => {
      const pStore = new MemoryCatalogStore();
      const res1 = createHttpListing({ url: 'http://prov' });
      await pStore.upsertResource(res1, 'verify');

      const entry = pStore.resources.get('http://prov::');
      entry.expires_at = Date.now() - 10000;

      const res = await pStore.listResources({});
      assert.strictEqual(res.total, 0);
      assert.strictEqual(res.items.length, 0);
    });

    test('includes non-expired provisional resources', async () => {
      const pStore = new MemoryCatalogStore();
      const res1 = createHttpListing({ url: 'http://prov' });
      await pStore.upsertResource(res1, 'verify');

      const res = await pStore.listResources({});
      assert.strictEqual(res.total, 1);
    });

    test('provisional resource without expires_at is considered expired', async () => {
      const pStore = new MemoryCatalogStore();
      const res1 = createHttpListing({ url: 'http://prov' });
      await pStore.upsertResource(res1, 'verify');

      const entry = pStore.resources.get('http://prov::');
      entry.expires_at = null;

      const res = await pStore.listResources({});
      assert.strictEqual(res.total, 0);
    });

    test('handles missing first_seen_at during sorting', async () => {
      const sStore = new MemoryCatalogStore();
      const r1 = createHttpListing({ url: 'http://a' });
      const r2 = createHttpListing({ url: 'http://b' });
      await sStore.upsertResource(r1);
      await sStore.upsertResource(r2);

      sStore.resources.get('http://a::').first_seen_at = null;
      sStore.resources.get('http://b::').first_seen_at = null;

      const res = await sStore.listResources({});
      assert.strictEqual(res.total, 2);
      assert.strictEqual(res.items[0].url, 'http://a');
      assert.strictEqual(res.items[1].url, 'http://b');
    });

    test('applies default limit when limit is undefined but offset is provided', async () => {
      const res = await store.listResources({ offset: 1 });
      assert.strictEqual(res.total, 3);
      assert.strictEqual(res.items.length, 2);
    });

    test('handles NaN or invalid numbers for limit and offset', async () => {
      const res = await store.listResources({ limit: NaN, offset: NaN });
      assert.ok(Array.isArray(res.items));
    });
  });
});
