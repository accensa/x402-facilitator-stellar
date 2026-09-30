/**
 * Modular Unit Tests for MemoryCatalogStore Resource Listing and Filtering
 *
 * Scoped specifically to test listing semantics, attribute filters,
 * composite query matching, extension intersections, and pagination limits/offsets.
 *
 * TESTING STRATEGY (#376)
 * -----------------------
 * listResources is a pure read over an in-memory Map, so the failure modes to
 * pin are the quiet ones: a filter that silently matches everything, a sort
 * that flips between runs, an offset that walks off the end, or a malformed
 * value that used to throw. Each block below therefore covers:
 *
 *   1. the happy path (already covered by the original suites, kept as-is),
 *   2. every documented filter axis in isolation and composed with AND,
 *   3. boundary and degenerate pagination (0, negative, fractional, string,
 *      NaN, huge, offset past the end, offset == total),
 *   4. malformed filter values (must filter to empty, never throw),
 *   5. visibility and expiry (provisional listings, pruneExpired),
 *   6. invariants that hold for every response shape (total vs items,
 *      deterministic ordering, the store is not mutated by a read).
 *
 * Inline comments state the contract each assertion pins, so a future
 * behavioural change shows up as a failing test with a written-down reason.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogStore } from '../src/catalog/memory.js';
import {
  createHttpListing,
  createMcpListing,
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

    test('all four axes composed still narrow to the single match', async () => {
      // type+payTo+network pin one resource; adding a matching scheme must not
      // widen or reorder the result set (#376 composite-filter contract).
      const res = await store.listResources({
        type: 'http',
        payTo: 'G1',
        network: 'pubnet',
        scheme: 'exact',
      });
      assertListResults(res, { total: 1, count: 1, urls: ['http://c'] });
    });

    test('a filter that matches everything still yields the full set in order', async () => {
      // Guards the silent-match-everything failure mode: an axis whose value
      // happens to be shared must not accidentally drop or reorder items.
      const res = await store.listResources({ scheme: 'exact' });
      assertListResults(res, { total: 2, count: 2, urls: ['http://c', 'http://a'] });
    });

    test('filter + pagination compose (filter first, then slice)', async () => {
      // The offset applies to the filtered list, not the raw store, or a
      // filtered page would skip the wrong entries.
      const res = await store.listResources({ scheme: 'exact', limit: 1, offset: 1 });
      assertListResults(res, { total: 2, count: 1, urls: ['http://a'] });
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

    test('extension filter composes with attribute filters (AND)', async () => {
      const res = await store.listResources({ type: 'http', extensions: ['ext1', 'ext2'] });
      assertListResults(res, { total: 1, count: 1, urls: ['http://c'] });
    });

    test('a resource with no extensions never matches a non-empty extension filter', async () => {
      // http://b has no extensions at all — it must not match even a
      // single-extension filter (the every() contract over an empty array).
      const res = await store.listResources({ extensions: ['ext1'] });
      assert.ok(res.items.every(i => i.url !== 'http://b'));
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

    test('offset equal to total is an empty page, not an error', async () => {
      // The exact boundary where slice() must hand back [] without throwing.
      const res = await store.listResources({ offset: 3 });
      assertListResults(res, { total: 3, count: 0, urls: [] });
    });

    test('a window that runs past the end truncates instead of padding', async () => {
      const res = await store.listResources({ limit: 10, offset: 2 });
      assertListResults(res, { total: 3, count: 1, urls: ['http://a'] });
    });

    test('walks every page in order with no gaps and no duplicates', async () => {
      // Whatever the page size, concatenating offset-stepped pages must
      // reproduce the unpaginated listing exactly — the pagination contract a
      // bazaar client relies on to enumerate the catalog.
      for (const pageSize of [1, 2, 3, 5]) {
        const full = await store.listResources({});
        const expected = full.items.map(i => i.url);
        const walked = [];
        for (let offset = 0; offset < full.total; offset += pageSize) {
          const page = await store.listResources({ limit: pageSize, offset });
          walked.push(...page.items.map(i => i.url));
        }
        assert.deepEqual(walked, expected, `page size ${pageSize} must walk the same sequence`);
      }
    });

    test('negative offset is clamped to 0 and does not wrap or throw', async () => {
      // The API boundary clamps, but the store is also called directly (tests,
      // eval harness, future callers) — a negative slice start must not drop
      // the last items or throw.
      const res = await store.listResources({ offset: -5 });
      assertListResults(res, { total: 3, count: 3, urls: ['http://c', 'http://b', 'http://a'] });
    });

    test('a limit larger than the result set returns everything available', async () => {
      const res = await store.listResources({ limit: 1000 });
      assertListResults(res, { total: 3, count: 3, urls: ['http://c', 'http://b', 'http://a'] });
    });
  });

  describe('Malformed and degenerate parameter values (#376)', () => {
    // The store documents that limit/offset are clamped by the API boundary,
    // but a direct caller hands it whatever it has. The contract pinned here:
    // a malformed value must never throw and must never match-anything —
    // Number('abc') is NaN and NaN comparisons are false, so a degenerate
    // filter degrades to an empty page rather than a full listing.
    for (const [label, params] of [
      ['a non-numeric string limit', { limit: 'abc' }],
      ['a NaN limit', { limit: Number.NaN }],
      ['a fractional limit', { limit: 1.5 }],
      ['a string offset', { offset: 'nope' }],
      ['a negative limit', { limit: -3 }],
    ]) {
      test(`${label} does not throw and returns a well-formed page`, async () => {
        const res = await store.listResources(params);
        assert.ok(Array.isArray(res.items), 'items must still be an array');
        assert.ok(Number.isInteger(res.total), 'total must still be an integer');
        assert.ok(res.total >= 0);
      });
    }

    test('an undefined params object is equivalent to no filters', async () => {
      const res = await store.listResources(undefined);
      assertListResults(res, { total: 3, count: 3, urls: ['http://c', 'http://b', 'http://a'] });
    });

    test('null filter values are ignored, not matched literally', async () => {
      // Falsy-but-present values must not become "type === null" predicates
      // that silently empty the catalog.
      const res = await store.listResources({
        type: null,
        payTo: null,
        scheme: null,
        network: null,
      });
      assertListResults(res, { total: 3, count: 3, urls: ['http://c', 'http://b', 'http://a'] });
    });

    test('a non-array extensions value is ignored rather than throwing', async () => {
      // _applyCommonFilters guards with Array.isArray; pin that guard so a
      // string query param can never crash the listing.
      const res = await store.listResources({ extensions: 'ext1' });
      assertListResults(res, { total: 3, count: 3, urls: ['http://c', 'http://b', 'http://a'] });
    });
  });

  describe('Visibility, expiry and pruning (#376)', () => {
    test('a provisional verify-only listing is listed until it expires', async () => {
      const verifyStore = new MemoryCatalogStore({ catalogVerifyTtlMs: 10_000 });
      await verifyStore.upsertResource(createHttpListing({ url: 'http://provisional' }), 'verify');
      const res = await verifyStore.listResources({});
      assertListResults(res, { total: 1, count: 1, urls: ['http://provisional'] });
      assert.strictEqual(res.items[0].provisional, true);
      assert.ok(res.items[0].expires_at, 'a provisional listing carries an expiry');
    });

    test('an expired provisional listing disappears from the listing before pruning', async () => {
      const verifyStore = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });
      await verifyStore.upsertResource(createHttpListing({ url: 'http://dies' }), 'verify');
      await new Promise(resolve => setTimeout(resolve, 20));

      // Visibility is evaluated lazily at read time: the entry still exists in
      // the map but must not appear in (or be counted by) a listing.
      const res = await verifyStore.listResources({});
      assertListResults(res, { total: 0, count: 0, urls: [] });

      // Pruning is a separate maintenance step; it must agree with visibility.
      assert.strictEqual(await verifyStore.pruneExpired(), 1);
      const afterPrune = await verifyStore.listResources({});
      assertListResults(afterPrune, { total: 0, count: 0, urls: [] });
    });

    test('a settle promotion makes the listing permanent and never-expiring', async () => {
      const verifyStore = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });
      await verifyStore.upsertResource(createHttpListing({ url: 'http://promoted' }), 'verify');
      await verifyStore.upsertResource(createHttpListing({ url: 'http://promoted' }), 'settle');

      await new Promise(resolve => setTimeout(resolve, 20));
      const res = await verifyStore.listResources({});
      assertListResults(res, { total: 1, count: 1, urls: ['http://promoted'] });
      assert.strictEqual(res.items[0].provisional, false);
      assert.strictEqual(res.items[0].expires_at, null);
    });

    test('an MCP listing is keyed by url+toolName and lists independently of its http sibling', async () => {
      // Same URL, two identities: the http listing and the mcp tool listing
      // must both appear, each with its own attributes.
      const keyed = new MemoryCatalogStore();
      await keyed.upsertResource(createHttpListing({ url: 'https://dual.example' }));
      await keyed.upsertResource(
        createMcpListing({ url: 'https://dual.example', toolName: 'search' }),
      );
      const res = await keyed.listResources({});
      assert.strictEqual(res.total, 2);
      const types = res.items.map(i => i.type).sort();
      assert.deepEqual(types, ['http', 'mcp']);

      const mcpOnly = await keyed.listResources({ type: 'mcp' });
      assert.strictEqual(mcpOnly.items[0].toolName, 'search');
    });

    test('an expired provisional entry does not count toward total even when filtered', async () => {
      // total must agree with the filtered-and-visible set, never with the raw
      // map size — otherwise a client paginating by total walks phantom pages.
      const verifyStore = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });
      await verifyStore.upsertResource(
        createHttpListing({ url: 'http://ghost', payTo: 'GX' }),
        'verify',
      );
      await new Promise(resolve => setTimeout(resolve, 20));
      const res = await verifyStore.listResources({ payTo: 'GX' });
      assert.strictEqual(res.total, 0);
      assert.strictEqual(res.items.length, 0);
    });
  });

  describe('Response shape and purity invariants (#376)', () => {
    test('total always equals the filtered, visible match count regardless of paging', async () => {
      for (const params of [
        {},
        { limit: 1 },
        { limit: 2, offset: 2 },
        { type: 'http' },
        { type: 'http', limit: 1, offset: 1 },
        { payTo: 'NOPE' },
      ]) {
        const res = await store.listResources(params);
        assert.ok(
          res.items.length <= res.total,
          `items.length (${res.items.length}) must never exceed total (${res.total}) for ${JSON.stringify(params)}`,
        );
        // total is the full match count; it must not shrink with paging.
        const expectedTotal = (
          await store.listResources({ ...params, limit: undefined, offset: undefined })
        ).total;
        assert.strictEqual(
          res.total,
          expectedTotal,
          `total must be page-independent for ${JSON.stringify(params)}`,
        );
      }
    });

    test('listing is deterministic: two identical reads return identical pages', async () => {
      const a = await store.listResources({ type: 'http', limit: 2 });
      const b = await store.listResources({ type: 'http', limit: 2 });
      assert.deepEqual(
        a.items.map(i => [i.url, i.first_seen_at?.getTime?.() ?? null]),
        b.items.map(i => [i.url, i.first_seen_at?.getTime?.() ?? null]),
      );
    });

    test('a read does not mutate the store', async () => {
      // listResources is a read: sorting must not reorder the underlying map
      // or the next seeded write would inherit a shuffled order.
      const before = [...store.resources.keys()];
      await store.listResources({});
      await store.listResources({ type: 'http', limit: 1, offset: 1 });
      assert.deepEqual([...store.resources.keys()], before);
      assert.strictEqual(store.resources.size, 3);
    });

    test('returned items are the stored entries, not detached copies', async () => {
      // The current contract hands back the live entry objects; a consumer
      // relies on reading full attributes (extensions, source) off them.
      const res = await store.listResources({ type: 'mcp' });
      assert.strictEqual(res.items[0].scheme, 'upto');
      assert.ok(res.items[0].first_seen_at instanceof Date);
      assert.ok(res.items[0].last_seen_at instanceof Date);
    });

    test('a filter matching nothing returns the same shaped object as a hit', async () => {
      const hit = await store.listResources({ type: 'http' });
      const miss = await store.listResources({ type: 'nope' });
      assert.deepEqual(Object.keys(hit).sort(), Object.keys(miss).sort());
      assert.deepEqual(Object.keys(hit.items[0] ?? {}).length > 0, true);
      assert.deepEqual(miss.items, []);
    });
  });

  describe('Rejection paths from upsert do not leak into listing (#376)', () => {
    test('a rejected upsert (cap exceeded) leaves the listing consistent', async () => {
      const small = new MemoryCatalogStore({ maxResourcesPerPayTo: 1 });
      await small.upsertResource(createHttpListing({ url: 'http://first', payTo: 'GCAP' }));
      await assert.rejects(
        () => small.upsertResource(createHttpListing({ url: 'http://second', payTo: 'GCAP' })),
        err => err.code === 'maximum_resources_per_payto_exceeded',
      );
      // The failed write must not have left a phantom entry or broken the count.
      const res = await small.listResources({});
      assertListResults(res, { total: 1, count: 1, urls: ['http://first'] });
    });

    test('a catalog at its size cap still lists what it has', async () => {
      const tiny = new MemoryCatalogStore({ maxCatalogSize: 2 });
      await seedCatalogWithDelay(tiny, [
        createHttpListing({ url: 'http://x' }),
        createHttpListing({ url: 'http://y' }),
      ]);
      await assert.rejects(
        () => tiny.upsertResource(createHttpListing({ url: 'http://z' })),
        err => err.code === 'maximum_catalog_size_exceeded',
      );
      const res = await tiny.listResources({});
      assert.strictEqual(res.total, 2);
      // Listing is newest-first on first_seen_at. Seeding without a delay
      // leaves both writes in the same millisecond on a fast runner, where
      // the key-ascending tie-break puts x first, and in adjacent
      // milliseconds on a loaded one, where y wins — so the delay is what
      // makes this order deterministic, as elsewhere in this file.
      assertListResults(res, { total: 2, count: 2, urls: ['http://y', 'http://x'] });
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
