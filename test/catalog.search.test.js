/**
 * @file Exhaustive unit tests for catalog search (#371).
 *
 * Covers {@link MemoryCatalogStore#search} directly, plus the two scoring
 * primitives it is built on in src/catalog/search.js — `scoreResource` and
 * `toEpochMillis`.
 *
 * TESTING STRATEGY (#371)
 * -----------------------
 * Search is a pure read over an in-memory Map that fuses a lexical score with
 * an optional dense one, so the failure modes worth pinning are the quiet
 * ones: a filter that silently widens the result set, a ranking rule that
 * flips between runs, a cursor that walks off the end, or a malformed stored
 * value that turns a read into a 500. Each block below therefore covers:
 *
 *   1. the response contract and its defaults (shape, no legacy `total`,
 *      `partialResults` truthfulness);
 *   2. lexical scoring in isolation — every weighted axis, the payment-source
 *      boost, the recency decay, and malformed input that must never throw;
 *   3. `toEpochMillis` in isolation, since it is the boundary that keeps a bad
 *      stored timestamp from crashing a ranking helper;
 *   4. query matching (case, multi-token, extension indexing);
 *   5. every documented filter axis in isolation and composed with AND;
 *   6. ranking: payment boost, deterministic key tie-break, recency ordering;
 *   7. opaque cursor pagination — walking every page, the last page, and the
 *      degenerate cursors (non-offset, non-base64, negative, out-of-range,
 *      NaN);
 *   8. the hybrid path with a stubbed embedding provider: dense-only hits,
 *      the relevance threshold, dimension/zero-vector guards, and the
 *      `partialResults` flag across all three provider outcomes;
 *   9. the optional rerank pass (#170): page-only reordering, and the
 *      configured-but-unreachable endpoint degrading to fused order;
 *  10. visibility and expiry (#140), including the prune/read agreement;
 *  11. invariants that hold for every response, so a future behavioural change
 *      shows up as a failing test with a written-down reason.
 *
 * Inline comments state the contract each assertion pins rather than restating
 * the code.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogStore } from '../src/catalog/memory.js';
import { scoreResource, toEpochMillis } from '../src/catalog/search.js';
import {
  assertSearchShape,
  assertServiceNames,
  financeResource,
  seededSearchStore,
  settleClock,
  weatherResource,
  weatherTwoResource,
} from './helpers/catalog-search.js';

/** One day in milliseconds, used by the recency and decay fixtures. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Attaches a stubbed embedding provider to a store, after its listings have
 * already been seeded.
 *
 * The real EmbeddingClient performs HTTP, and a unit test must not depend on
 * a network round trip, so the provider is replaced at the client boundary —
 * everything above it (fusion, thresholding, `partialResults`) is the real
 * implementation under test.
 *
 * Ordering matters: a store built with a provider URL eagerly schedules a
 * background re-embed on every upsert, which would fill in vectors a test
 * deliberately leaves absent and silently overwrite the ones it sets. Attach
 * the provider only once seeding is done.
 *
 * @param {MemoryCatalogStore} store
 * @param {number[]|null} vector - Vector every `embed()` call resolves to.
 * @returns {MemoryCatalogStore} The same store, for chaining.
 */
function enableProvider(store, vector) {
  store.embeddingClient.url = 'https://embeddings.test/vectors';
  store.embeddingClient.embed = async () => vector;
  return store;
}

/**
 * Rewrites a stored listing's `last_seen_at` so recency-decay ordering can be
 * tested without waiting real time. Entries are live objects by contract, so
 * mutating one is visible to the next read.
 *
 * @param {MemoryCatalogStore} store
 * @param {string} url
 * @param {number} days - Age in days to backdate the entry by.
 * @returns {object} The mutated entry.
 */
function backdate(store, url, days) {
  const entry = store.resources.get(`${url}::`);
  entry.last_seen_at = new Date(Date.now() - days * DAY_MS);
  return entry;
}

/**
 * Pins a stored listing's `last_seen_at` to an exact instant. Two listings
 * touched in different milliseconds would otherwise carry a microscopic decay
 * difference that decides their order before any tie-break rule can.
 *
 * @param {MemoryCatalogStore} store
 * @param {string} url
 * @param {Date} [when=new Date()]
 * @returns {object} The mutated entry.
 */
function pinLastSeen(store, url, when = new Date()) {
  const entry = store.resources.get(`${url}::`);
  entry.last_seen_at = when;
  return entry;
}

describe('toEpochMillis (src/catalog/search.js)', () => {
  test('returns null for null and undefined', () => {
    assert.strictEqual(toEpochMillis(null), null);
    assert.strictEqual(toEpochMillis(undefined), null);
  });

  test('converts a valid Date to epoch milliseconds', () => {
    const date = new Date('2024-05-01T12:00:00Z');
    assert.strictEqual(toEpochMillis(date), date.getTime());
  });

  test('returns null for an Invalid Date instead of NaN', () => {
    // NaN would poison every comparison downstream, so it is normalized away.
    assert.strictEqual(toEpochMillis(new Date('not-a-date')), null);
  });

  test('passes through finite numbers, including 0', () => {
    assert.strictEqual(toEpochMillis(0), 0);
    assert.strictEqual(toEpochMillis(1_700_000_000_000), 1_700_000_000_000);
  });

  test('returns null for NaN and infinite numbers', () => {
    assert.strictEqual(toEpochMillis(Number.NaN), null);
    assert.strictEqual(toEpochMillis(Number.POSITIVE_INFINITY), null);
    assert.strictEqual(toEpochMillis(Number.NEGATIVE_INFINITY), null);
  });

  test('parses an ISO string into epoch milliseconds', () => {
    assert.strictEqual(
      toEpochMillis('2024-05-01T12:00:00.000Z'),
      Date.parse('2024-05-01T12:00:00.000Z'),
    );
  });

  test('returns null for an unparseable string', () => {
    assert.strictEqual(toEpochMillis('yesterday-ish'), null);
  });

  test('returns null for every non-Date/number/string type', () => {
    // A malformed stored value must degrade to "no timestamp", never throw.
    for (const value of [true, false, {}, [], () => {}, Symbol('x'), 10n]) {
      assert.strictEqual(toEpochMillis(value), null, `expected null for ${String(value)}`);
    }
  });
});

describe('scoreResource — lexical scoring (src/catalog/search.js)', () => {
  test('scores 0 for a missing, empty, or whitespace-only query', () => {
    // An empty query must not act as "match everything": the store filters on
    // score > 0, so 0 here is what keeps a blank search from dumping the catalog.
    const resource = weatherResource();
    assert.strictEqual(scoreResource(resource, ''), 0);
    assert.strictEqual(scoreResource(resource, '   '), 0);
    assert.strictEqual(scoreResource(resource, undefined), 0);
    assert.strictEqual(scoreResource(resource, null), 0);
  });

  test('scores 0 when nothing in the resource matches', () => {
    assert.strictEqual(scoreResource(weatherResource(), 'quantum'), 0);
  });

  test('weights a serviceName match at 10', () => {
    // No last_seen_at means no decay, so the raw weight is observable.
    assert.strictEqual(scoreResource({ serviceName: 'Weather API' }, 'weather'), 10);
  });

  test('is case-insensitive in both directions', () => {
    assert.strictEqual(scoreResource({ serviceName: 'WEATHER API' }, 'weather'), 10);
    assert.strictEqual(scoreResource({ serviceName: 'Weather API' }, 'WEATHER'), 10);
  });

  test('weights an exact tag match at 8 and a partial tag match at 4', () => {
    // Service name deliberately does not contain the token so the tag weight
    // is isolated.
    assert.strictEqual(scoreResource({ serviceName: 'X', tags: ['weather'] }, 'weather'), 8);
    assert.strictEqual(scoreResource({ serviceName: 'X', tags: ['weatherish'] }, 'weather'), 4);
  });

  test('an exact tag outranks a partial tag for the same query', () => {
    const exact = scoreResource({ serviceName: 'X', tags: ['weather'] }, 'weather');
    const partial = scoreResource({ serviceName: 'X', tags: ['weatherish'] }, 'weather');
    assert.ok(exact > partial, 'exact tag match must outrank a substring match');
  });

  test('weights a description match at 3', () => {
    assert.strictEqual(
      scoreResource({ serviceName: 'X', description: 'Get current weather' }, 'weather'),
      3,
    );
  });

  test('indexes extension values at weight 1', () => {
    // The extension text ("secret token") is only reachable through the
    // stringified extensions blob, so this pins that indexing path.
    assert.strictEqual(
      scoreResource(
        { serviceName: 'X', extensions: { custom: { description: 'secret token' } } },
        'secret',
      ),
      1,
    );
  });

  test('accumulates each matching token across every weighted axis', () => {
    // serviceName 10 + description 3 = 13 for a resource with no tags/extensions.
    assert.strictEqual(
      scoreResource({ serviceName: 'Weather API', description: 'weather forecast' }, 'weather'),
      13,
    );
  });

  test('sums multiple query tokens that hit different axes', () => {
    const resource = { serviceName: 'Weather API', description: 'stock prices' };
    // weather -> 10, stock -> 3.
    assert.strictEqual(scoreResource(resource, 'weather stock'), 13);
  });

  test('adds the payment-source boost only when the resource already scores', () => {
    // The boost must not manufacture a match out of a non-match.
    assert.strictEqual(scoreResource({ serviceName: 'Weather', source: 'payment' }, 'quantum'), 0);
    assert.strictEqual(scoreResource({ serviceName: 'Weather', source: 'payment' }, 'weather'), 15);
  });

  test('does not boost a manual or unknown source', () => {
    assert.strictEqual(scoreResource({ serviceName: 'Weather', source: 'manual' }, 'weather'), 10);
    assert.strictEqual(scoreResource({ serviceName: 'Weather' }, 'weather'), 10);
  });

  test('tolerates a non-array tags value without throwing', () => {
    const score = scoreResource({ serviceName: 'X', tags: 'weather' }, 'weather');
    assert.strictEqual(score, 0);
  });

  test('tolerates a non-object extensions value without throwing', () => {
    // A string extension payload is skipped rather than stringified, so it
    // cannot contribute a false positive.
    assert.strictEqual(
      scoreResource({ serviceName: 'X', extensions: 'secret token' }, 'secret'),
      0,
    );
    assert.strictEqual(scoreResource({ serviceName: 'X', extensions: null }, 'secret'), 0);
  });

  test('decays a score by roughly half after ~30 days', () => {
    const fresh = scoreResource({ serviceName: 'Weather' }, 'weather');
    const month = scoreResource(
      { serviceName: 'Weather', last_seen_at: new Date(Date.now() - 30 * DAY_MS) },
      'weather',
    );
    assert.ok(month < fresh, 'an older listing must score lower');
    assert.ok(
      month > fresh * 0.4 && month < fresh * 0.6,
      `expected ~half of ${fresh}, got ${month}`,
    );
  });

  test('decays monotonically with age', () => {
    const day = scoreResource(
      { serviceName: 'Weather', last_seen_at: new Date(Date.now() - DAY_MS) },
      'weather',
    );
    const month = scoreResource(
      { serviceName: 'Weather', last_seen_at: new Date(Date.now() - 30 * DAY_MS) },
      'weather',
    );
    const year = scoreResource(
      { serviceName: 'Weather', last_seen_at: new Date(Date.now() - 365 * DAY_MS) },
      'weather',
    );
    assert.ok(day > month && month > year, 'older listings must decay further');
    assert.ok(year < 0.01, 'a year-old listing is effectively irrelevant');
  });

  test('applies no decay when last_seen_at is missing or unparseable', () => {
    // The scorer must never throw on a stored value it did not write.
    const malformed = [undefined, null, new Date('nope'), 'not-a-date', {}, [], Number.NaN];
    for (const value of malformed) {
      const score = scoreResource({ serviceName: 'Weather', last_seen_at: value }, 'weather');
      assert.strictEqual(score, 10, `expected undecayed score for ${String(value)}`);
    }
  });

  test('applies no decay to a future last_seen_at', () => {
    // A clock-skewed future timestamp must not amplify the score.
    const future = scoreResource(
      { serviceName: 'Weather', last_seen_at: new Date(Date.now() + 5 * DAY_MS) },
      'weather',
    );
    assert.strictEqual(future, 10);
  });
});

describe('MemoryCatalogStore.search — response contract', () => {
  test('returns resources + pagination and never a legacy total', async () => {
    const store = await seededSearchStore();
    const res = await store.search({ query: 'api' });
    assertSearchShape(res);
    assert.deepStrictEqual(Object.keys(res.pagination).sort(), ['cursor', 'limit']);
    assert.strictEqual(res.pagination.limit, 20, 'default limit is 20');
  });

  test('flags partialResults when no embedding provider is configured', async () => {
    // Truth in advertising: keyword-only recall must be labelled partial.
    const store = await seededSearchStore();
    const res = await store.search({ query: 'api' });
    assert.strictEqual(res.partialResults, true);
  });

  test('returns an empty, well-formed page for an untouched store', async () => {
    const store = new MemoryCatalogStore();
    const res = await store.search({ query: 'anything' });
    assertSearchShape(res);
    assert.deepStrictEqual(res.resources, []);
    assert.strictEqual(res.pagination.cursor, null);
  });

  test('returns an empty page (not an error) when nothing matches', async () => {
    const store = await seededSearchStore();
    const res = await store.search({ query: 'no-such-service' });
    assert.deepStrictEqual(res.resources, []);
    assert.strictEqual(res.pagination.cursor, null);
  });

  test('an empty query matches nothing rather than everything', async () => {
    // A blank search must not degrade into an unfiltered catalog dump.
    const store = await seededSearchStore();
    const res = await store.search({ query: '' });
    assert.deepStrictEqual(res.resources, []);
  });

  test('a params object without a query is well-formed', async () => {
    const store = await seededSearchStore();
    const res = await store.search({});
    assert.ok(Array.isArray(res.resources));
    assert.ok(Number.isInteger(res.pagination.limit));
  });

  test('echoes the requested limit back in pagination', async () => {
    const store = await seededSearchStore();
    const res = await store.search({ query: 'api', limit: 1 });
    assert.strictEqual(res.pagination.limit, 1);
  });

  test('is deterministic: two identical searches return the same order', async () => {
    const store = await seededSearchStore();
    const a = await store.search({ query: 'api' });
    const b = await store.search({ query: 'api' });
    assert.deepStrictEqual(
      a.resources.map(r => r.url),
      b.resources.map(r => r.url),
    );
  });

  test('a search does not mutate the store', async () => {
    const store = await seededSearchStore();
    const before = [...store.resources.keys()];
    await store.search({ query: 'api', limit: 1 });
    await store.search({ query: 'weather' });
    assert.deepStrictEqual([...store.resources.keys()], before);
  });
});

describe('MemoryCatalogStore.search — query matching', () => {
  test('matches free text case-insensitively', async () => {
    const store = await seededSearchStore();
    assertServiceNames(await store.search({ query: 'WEATHER' }), ['Weather API']);
  });

  test('indexes extension text', async () => {
    // "secret token" exists only inside the custom extension description.
    const store = await seededSearchStore();
    assertServiceNames(await store.search({ query: 'secret token' }), ['Weather API']);
  });

  test('excludes resources with a zero score even when they are public', async () => {
    const store = await seededSearchStore();
    const res = await store.search({ query: 'weather' });
    assert.ok(res.resources.every(r => r.serviceName !== 'Finance API'));
  });

  test('matches on a multi-token query', async () => {
    const store = await seededSearchStore();
    // Both tokens appear in the Weather listing's name/description.
    assertServiceNames(await store.search({ query: 'weather current' }), ['Weather API']);
  });

  test('composes an extension filter with the query instead of replacing it', async () => {
    // Both fixtures match "api"; only Weather advertises `custom`.
    const store = await seededSearchStore();
    assertServiceNames(await store.search({ query: 'api', extensions: ['custom'] }), [
      'Weather API',
    ]);
  });
});

describe('MemoryCatalogStore.search — ranking', () => {
  test('a payment-sourced listing outranks an equally relevant manual one', async () => {
    const store = await seededSearchStore();
    await store.upsertResource(weatherTwoResource(), 'manual');
    assertServiceNames(await store.search({ query: 'weather' }), ['Weather API', 'Weather API 2']);
  });

  test('equal fused scores tie-break deterministically by key ascending', async () => {
    // Built so the two listings take mirrored ranks: one leads the lexical
    // list and trails the dense one, the other the reverse. Their fused (RRF)
    // scores are identical, so only the key-ascending tie-break can decide —
    // and it must decide the same way on every run or paging stops being
    // monotonic. The 'b' listing is inserted first, so insertion order would
    // produce the opposite answer, proving the tie-break is what is observed.
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://tie.test/b',
      serviceName: 'Beta',
      tags: ['alpha'],
      embedding: [1, 0, 0],
    });
    await store.upsertResource({
      url: 'https://tie.test/a',
      serviceName: 'Alpha',
      embedding: [1, 0.5, 0],
    });
    const pinned = new Date();
    pinLastSeen(store, 'https://tie.test/a', pinned);
    pinLastSeen(store, 'https://tie.test/b', pinned);
    enableProvider(store, [1, 0, 0]);

    const res = await store.search({ query: 'alpha' });
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://tie.test/a', 'https://tie.test/b'],
    );
  });

  test('a fresher listing outranks a stale equally-relevant one', async () => {
    // Recency decay must be observable through the ranking, not just in the
    // scorer: both listings match "twin" identically, so only age separates
    // them. The stale listing is inserted first, so insertion order cannot
    // explain the observed freshness ordering.
    const store = new MemoryCatalogStore();
    const base = { serviceName: 'Twin API', description: 'twin prices', type: 'http' };
    await store.upsertResource({ ...base, url: 'https://stale.test/x' }, 'payment');
    await store.upsertResource({ ...base, url: 'https://fresh.test/x' }, 'payment');
    backdate(store, 'https://stale.test/x', 120);
    const res = await store.search({ query: 'twin' });
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://fresh.test/x', 'https://stale.test/x'],
    );
  });

  test('a zero-scoring resource is never ranked in, however fresh it is', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource({ url: 'https://unrelated.test/x', serviceName: 'Unrelated' });
    const res = await store.search({ query: 'twin' });
    assert.deepStrictEqual(res.resources, []);
  });
});

describe('MemoryCatalogStore.search — filter composition', () => {
  /**
   * Seeds a heterogeneous store so every filter axis has a discriminating
   * fixture: three http listings (two on payTo G1) and one mcp tool.
   */
  async function seededFilterStore() {
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://filters.test/a',
      serviceName: 'Filter A',
      type: 'http',
      payTo: 'G1',
      scheme: 'exact',
      network: 'testnet',
      extensions: { ext1: true },
    });
    await store.upsertResource({
      url: 'https://filters.test/b',
      serviceName: 'Filter B',
      type: 'mcp',
      toolName: 'tool',
      payTo: 'G2',
      scheme: 'upto',
      network: 'pubnet',
      extensions: { ext1: true, ext2: true },
    });
    await store.upsertResource({
      url: 'https://filters.test/c',
      serviceName: 'Filter C',
      type: 'http',
      payTo: 'G1',
      scheme: 'exact',
      network: 'pubnet',
    });
    return store;
  }

  test('filters by type', async () => {
    const store = await seededFilterStore();
    assertServiceNames(await store.search({ query: 'filter', type: 'mcp' }), ['Filter B']);
  });

  test('filters by payTo', async () => {
    const store = await seededFilterStore();
    const res = await store.search({ query: 'filter', payTo: 'G1' });
    assert.ok(res.resources.every(r => r.payTo === 'G1'));
    assert.strictEqual(res.resources.length, 2);
  });

  test('filters by scheme', async () => {
    const store = await seededFilterStore();
    assertServiceNames(await store.search({ query: 'filter', scheme: 'upto' }), ['Filter B']);
  });

  test('filters by network', async () => {
    const store = await seededFilterStore();
    assertServiceNames(await store.search({ query: 'filter', network: 'testnet' }), ['Filter A']);
  });

  test('filters by a required extension', async () => {
    const store = await seededFilterStore();
    assertServiceNames(await store.search({ query: 'filter', extensions: ['ext2'] }), ['Filter B']);
  });

  test('requires every listed extension (AND, not OR)', async () => {
    const store = await seededFilterStore();
    const res = await store.search({ query: 'filter', extensions: ['ext1', 'ext2'] });
    assertServiceNames(res, ['Filter B']);
  });

  test('a filter for an extension nobody advertises returns an empty page', async () => {
    const store = await seededFilterStore();
    const res = await store.search({ query: 'filter', extensions: ['nope'] });
    assert.deepStrictEqual(res.resources, []);
  });

  test('an empty extensions array filters nothing out', async () => {
    const store = await seededFilterStore();
    const res = await store.search({ query: 'filter', extensions: [] });
    assert.strictEqual(res.resources.length, 3);
  });

  test('composes multiple axes with AND', async () => {
    const store = await seededFilterStore();
    const res = await store.search({
      query: 'filter',
      type: 'http',
      payTo: 'G1',
      network: 'pubnet',
    });
    assertServiceNames(res, ['Filter C']);
  });

  test('a filter that excludes the best lexical match still removes it', async () => {
    // Filtering must happen before ranking, or the excluded listing leaks back
    // in through a high score.
    const store = await seededFilterStore();
    const res = await store.search({ query: 'filter', type: 'http' });
    assert.ok(res.resources.every(r => r.type === 'http'));
  });

  test('null filter values are ignored rather than matched literally', async () => {
    const store = await seededFilterStore();
    const res = await store.search({
      query: 'filter',
      type: null,
      payTo: null,
      scheme: null,
      network: null,
    });
    assert.strictEqual(res.resources.length, 3);
  });

  test('a non-array extensions value is ignored, not thrown on', async () => {
    const store = await seededFilterStore();
    const res = await store.search({ query: 'filter', extensions: 'ext1' });
    assert.strictEqual(res.resources.length, 3);
  });

  test('a filter matching nothing yields the same shape as a hit', async () => {
    const store = await seededFilterStore();
    const hit = await store.search({ query: 'filter' });
    const miss = await store.search({ query: 'filter', payTo: 'NOBODY' });
    assert.deepStrictEqual(Object.keys(hit).sort(), Object.keys(miss).sort());
    assert.deepStrictEqual(miss.resources, []);
  });
});

describe('MemoryCatalogStore.search — pagination and cursors', () => {
  /**
   * Seeds `count` identical listings so only pagination changes the page.
   * Every entry is pinned to the same instant: identical relevance plus
   * identical age is what makes the expected order a property of pagination
   * alone rather than of sub-millisecond upsert timing.
   */
  async function seededPageStore(count) {
    const store = new MemoryCatalogStore();
    const pinned = new Date();
    for (let i = 0; i < count; i += 1) {
      const url = `https://pages.test/${i}`;
      await store.upsertResource({ url, serviceName: 'Page API' });
      pinLastSeen(store, url, pinned);
    }
    return store;
  }

  test('honours limit without changing the candidate set', async () => {
    const store = await seededPageStore(5);
    const res = await store.search({ query: 'page', limit: 2 });
    assert.strictEqual(res.resources.length, 2);
    assert.ok(res.pagination.cursor, 'more candidates remain, so a cursor is issued');
  });

  test('caps the page at the default limit of 20 but keeps the rest reachable', async () => {
    // The default must bound the page, not the recall: a cursor has to be
    // issued so the remaining matches can still be fetched.
    const store = await seededPageStore(25);
    const res = await store.search({ query: 'page' });
    assert.strictEqual(res.resources.length, 20);
    assert.strictEqual(res.pagination.limit, 20);
    assert.strictEqual(Buffer.from(res.pagination.cursor, 'base64').toString('utf8'), 'offset:20');
  });

  test('walks every page with no gaps and no duplicates', async () => {
    // The pagination contract a bazaar client depends on to enumerate results.
    const store = await seededPageStore(5);
    const walked = [];
    let cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await store.search({ query: 'page', limit: 2, cursor });
      walked.push(...page.resources.map(r => r.url));
      cursor = page.pagination.cursor;
      if (!cursor) break;
    }
    assert.strictEqual(walked.length, 5);
    assert.strictEqual(new Set(walked).size, 5, 'no duplicates across pages');
    assert.deepStrictEqual(walked, [
      'https://pages.test/0',
      'https://pages.test/1',
      'https://pages.test/2',
      'https://pages.test/3',
      'https://pages.test/4',
    ]);
  });

  test('the final page issues no cursor', async () => {
    const store = await seededPageStore(2);
    const res = await store.search({ query: 'page', limit: 2 });
    assert.strictEqual(res.resources.length, 2);
    assert.strictEqual(res.pagination.cursor, null);
  });

  test('the cursor is an opaque base64 encoding of the next offset', async () => {
    const store = await seededPageStore(5);
    const res = await store.search({ query: 'page', limit: 2 });
    assert.strictEqual(Buffer.from(res.pagination.cursor, 'base64').toString('utf8'), 'offset:2');
  });

  test('a limit of 0 returns an empty page but still advertises the offset', async () => {
    // Degenerate but valid: the page is empty while candidates remain, so the
    // cursor must still be issued or a caller could never make progress.
    const store = await seededPageStore(3);
    const res = await store.search({ query: 'page', limit: 0 });
    assert.deepStrictEqual(res.resources, []);
    assert.strictEqual(Buffer.from(res.pagination.cursor, 'base64').toString('utf8'), 'offset:0');
  });

  test('a limit larger than the candidate set returns everything available', async () => {
    const store = await seededPageStore(3);
    const res = await store.search({ query: 'page', limit: 1000 });
    assert.strictEqual(res.resources.length, 3);
    assert.strictEqual(res.pagination.cursor, null);
  });

  test('a non-offset cursor payload falls back to the first page', async () => {
    const store = await seededPageStore(3);
    const cursor = Buffer.from('not-an-offset').toString('base64');
    const res = await store.search({ query: 'page', limit: 1, cursor });
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://pages.test/0'],
    );
  });

  test('a non-base64 cursor falls back to the first page instead of throwing', async () => {
    const store = await seededPageStore(3);
    const res = await store.search({ query: 'page', limit: 1, cursor: '!!!! not base64 !!!!' });
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://pages.test/0'],
    );
  });

  test('a negative cursor offset is clamped to the first page', async () => {
    const store = await seededPageStore(3);
    const cursor = Buffer.from('offset:-5').toString('base64');
    const res = await store.search({ query: 'page', limit: 1, cursor });
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://pages.test/0'],
    );
  });

  test('a cursor past the end is an empty page, not an error', async () => {
    const store = await seededPageStore(3);
    const cursor = Buffer.from('offset:9999').toString('base64');
    const res = await store.search({ query: 'page', limit: 1, cursor });
    assert.deepStrictEqual(res.resources, []);
    assert.strictEqual(res.pagination.cursor, null);
  });

  test('a non-numeric cursor offset degrades to an empty page', async () => {
    // parseInt("abc") is NaN; the bounds clamp propagates it and slice()
    // yields [] rather than the whole catalog or a throw.
    const store = await seededPageStore(3);
    const cursor = Buffer.from('offset:abc').toString('base64');
    const res = await store.search({ query: 'page', limit: 1, cursor });
    assert.deepStrictEqual(res.resources, []);
    assert.strictEqual(res.pagination.cursor, null);
  });

  test('pagination applies after ranking, not before', async () => {
    // Two relevance tiers 3 strong and 3 weak; a limit of 3 must return the
    // strong tier first, proving the slice happens on the ranked list.
    const store = new MemoryCatalogStore();
    for (let i = 0; i < 3; i += 1) {
      await store.upsertResource({
        url: `https://strong.test/${i}`,
        serviceName: 'Strong Alpha',
        description: 'alpha',
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await store.upsertResource({
        url: `https://weak.test/${i}`,
        serviceName: 'Weak Beta',
        tags: ['alpha'],
      });
    }
    const res = await store.search({ query: 'alpha', limit: 3 });
    assert.strictEqual(res.resources.length, 3);
    assert.ok(
      res.resources.every(r => r.url.startsWith('https://strong.test/')),
      'the highest-scoring tier must fill the first page',
    );
  });
});

describe('MemoryCatalogStore.search — hybrid ranking with an embedding provider', () => {
  test('reports full results when every candidate carries an embedding', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/a',
      serviceName: 'Alpha',
      embedding: [1, 0, 0],
    });
    enableProvider(store, [1, 0, 0]);
    const res = await store.search({ query: 'alpha' });
    assert.strictEqual(res.partialResults, false);
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://hybrid.test/a'],
    );
  });

  test('falls back to lexical results when the provider returns null', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/a',
      serviceName: 'Alpha',
      embedding: [1, 0, 0],
    });
    enableProvider(store, null);
    const res = await store.search({ query: 'alpha' });
    assert.strictEqual(
      res.partialResults,
      true,
      'a failed provider call makes the result set partial',
    );
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://hybrid.test/a'],
    );
  });

  test('flags partial results when one candidate has no embedding yet', async () => {
    // The provider is attached only after seeding, so listing b keeps the
    // missing vector this test is about instead of being filled in by the
    // background re-embed on upsert.
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/a',
      serviceName: 'Alpha',
      embedding: [1, 0, 0],
    });
    await store.upsertResource({ url: 'https://hybrid.test/b', serviceName: 'Alpha Two' });
    enableProvider(store, [1, 0, 0]);
    const res = await store.search({ query: 'alpha' });
    assert.strictEqual(res.partialResults, true);
    assert.strictEqual(res.resources.length, 2, 'an unembedded listing is still found lexically');
  });

  test('surfaces a dense-only hit with no lexical overlap', async () => {
    // The candidate matches no query token but its vector does; hybrid recall
    // must include it.
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/dense',
      serviceName: 'Gamma',
      embedding: [1, 0, 0],
    });
    enableProvider(store, [1, 0, 0]);
    const res = await store.search({ query: 'zzz' });
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://hybrid.test/dense'],
    );
  });

  test('excludes a candidate whose vectors are orthogonal (score at the threshold)', async () => {
    // cosine([1,0,0],[0,1,0]) is 0, below the 0.1 relevance threshold.
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/ortho',
      serviceName: 'Gamma',
      embedding: [0, 1, 0],
    });
    enableProvider(store, [1, 0, 0]);
    const res = await store.search({ query: 'zzz' });
    assert.deepStrictEqual(res.resources, []);
  });

  test('excludes a zero vector rather than dividing by zero', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/zero',
      serviceName: 'Gamma',
      embedding: [0, 0, 0],
    });
    enableProvider(store, [1, 0, 0]);
    const res = await store.search({ query: 'zzz' });
    assert.deepStrictEqual(res.resources, []);
  });

  test('a dimension mismatch contributes no dense score but stays lexically findable', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/dim',
      serviceName: 'Alpha',
      embedding: [1, 0],
    });
    enableProvider(store, [1, 0, 0]);
    const denseMiss = await store.search({ query: 'zzz' });
    assert.deepStrictEqual(denseMiss.resources, []);
    const lexicalHit = await store.search({ query: 'alpha' });
    assert.deepStrictEqual(
      lexicalHit.resources.map(r => r.url),
      ['https://hybrid.test/dim'],
    );
  });

  test('a listing matching both signals outranks one matching only the dense signal', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/both',
      serviceName: 'Alpha',
      embedding: [1, 0, 0],
    });
    await store.upsertResource({
      url: 'https://hybrid.test/dense',
      serviceName: 'Gamma',
      embedding: [1, 0, 0],
    });
    enableProvider(store, [1, 0, 0]);
    const res = await store.search({ query: 'alpha' });
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://hybrid.test/both', 'https://hybrid.test/dense'],
    );
  });

  test('a lexical-only and a dense-only hit both surface, ordered by key on an equal fused score', async () => {
    // RRF ranks, not raw scores: a solo lexical rank 0 and a solo dense rank 0
    // are worth the same, so the key-ascending tie-break decides the order.
    // Both must be present — neither signal may drop the other's hit.
    const store = new MemoryCatalogStore();
    await store.upsertResource({
      url: 'https://hybrid.test/lex',
      serviceName: 'Alpha Alpha',
      embedding: [0, 1, 0],
    });
    await store.upsertResource({
      url: 'https://hybrid.test/dense',
      serviceName: 'Gamma',
      embedding: [1, 0, 0],
    });
    const pinned = new Date();
    pinLastSeen(store, 'https://hybrid.test/lex', pinned);
    pinLastSeen(store, 'https://hybrid.test/dense', pinned);
    enableProvider(store, [1, 0, 0]);
    const res = await store.search({ query: 'alpha' });
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://hybrid.test/dense', 'https://hybrid.test/lex'],
    );
  });
});

describe('MemoryCatalogStore.search — optional reranking (#170)', () => {
  test('stays off and warns when enabled without a rerank URL', () => {
    // The old behaviour guessed `${EMBEDDINGS_URL}/rerank`, which no provider
    // serves; the guard is what makes "enabled" mean "happening".
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const store = new MemoryCatalogStore({ enableReranking: true });
      assert.strictEqual(store.enableReranking, false);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some(w => w.includes('RERANK_URL')),
      'a silently disabled reranker must be reported',
    );
  });

  test('is enabled when a rerank URL is configured', () => {
    const store = new MemoryCatalogStore({
      enableReranking: true,
      rerankUrl: 'https://rerank.test/score',
    });
    assert.strictEqual(store.enableReranking, true);
  });

  test('reorders only the returned page', async () => {
    const store = new MemoryCatalogStore({
      enableReranking: true,
      rerankUrl: 'https://rerank.test/score',
    });
    // Identical timestamps keep the fused order equal to insertion order, so
    // the observed reordering can only have come from the rerank pass.
    const pinned = new Date();
    for (let i = 0; i < 3; i += 1) {
      await store.upsertResource({ url: `https://rerank.test/${i}`, serviceName: 'Rerank API' });
      pinLastSeen(store, `https://rerank.test/${i}`, pinned);
    }
    const pages = [];
    store.embeddingClient.rerank = async (query, resources) => {
      pages.push(resources.length);
      return [...resources].reverse();
    };
    const res = await store.search({ query: 'rerank', limit: 2 });
    assert.deepStrictEqual(
      pages,
      [2],
      'reranking receives the page, never the whole candidate set',
    );
    assert.deepStrictEqual(
      res.resources.map(r => r.url),
      ['https://rerank.test/1', 'https://rerank.test/0'],
    );
  });

  test('skips reranking entirely when the page is empty', async () => {
    const store = new MemoryCatalogStore({
      enableReranking: true,
      rerankUrl: 'https://rerank.test/score',
    });
    let calls = 0;
    store.embeddingClient.rerank = async (query, resources) => {
      calls += 1;
      return resources;
    };
    const res = await store.search({ query: 'nothing' });
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(res.resources, []);
  });
});

describe('MemoryCatalogStore.search — visibility and expiry (#140)', () => {
  test('includes a provisional listing while its window is open', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 10_000 });
    await store.upsertResource({ url: 'https://prov.test/a', serviceName: 'Prov A' }, 'verify');
    assertServiceNames(await store.search({ query: 'prov' }), ['Prov A']);
  });

  test('drops a provisional listing once its window elapses, before pruning', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });
    await store.upsertResource({ url: 'https://prov.test/a', serviceName: 'Prov A' }, 'verify');
    await settleClock(20);
    const res = await store.search({ query: 'prov' });
    assert.deepStrictEqual(res.resources, []);
  });

  test('a settle promotion makes a listing permanent', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });
    await store.upsertResource({ url: 'https://prov.test/a', serviceName: 'Prov A' }, 'verify');
    await store.upsertResource({ url: 'https://prov.test/a', serviceName: 'Prov A' }, 'settle');
    await settleClock(20);
    assertServiceNames(await store.search({ query: 'prov' }), ['Prov A']);
  });

  test('pruneExpired and search agree about what is public', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });
    await store.upsertResource({ url: 'https://prov.test/a', serviceName: 'Prov A' }, 'verify');
    await settleClock(20);
    assert.strictEqual(await store.pruneExpired(), 1);
    assert.deepStrictEqual((await store.search({ query: 'prov' })).resources, []);
  });

  test('an expired listing is excluded from search even when a filter selects it', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });
    await store.upsertResource(
      { url: 'https://prov.test/a', serviceName: 'Prov A', payTo: 'GX' },
      'verify',
    );
    await settleClock(20);
    const res = await store.search({ query: 'prov', payTo: 'GX' });
    assert.deepStrictEqual(res.resources, []);
  });
});

describe('catalog search helper components', () => {
  test('seededSearchStore seeds both baseline fixtures', async () => {
    const store = await seededSearchStore();
    assertServiceNames(await store.search({ query: 'api' }), ['Weather API', 'Finance API']);
  });

  test('seededSearchStore fast mode seeds the same fixtures', async () => {
    // fast mode only shortens the clock settling; coverage must not change.
    const store = await seededSearchStore({ fastMode: true });
    const res = await store.search({ query: 'api' });
    assert.strictEqual(res.resources.length, 2);
  });

  test('fixture builders apply overrides without mutating defaults', () => {
    const custom = weatherResource({ serviceName: 'Custom Weather', tags: ['custom'] });
    assert.strictEqual(custom.serviceName, 'Custom Weather');
    assert.deepStrictEqual(custom.tags, ['custom']);
    // Defaults not overridden are preserved.
    assert.strictEqual(custom.url, 'https://example.com/api');

    // The pristine fixture is untouched by the override above.
    const pristine = weatherResource();
    assert.strictEqual(pristine.serviceName, 'Weather API');
    assert.deepStrictEqual(pristine.tags, ['weather', 'forecast']);
  });

  test('weatherResource merges extension overrides instead of replacing them', () => {
    const resource = weatherResource({ extensions: { custom: { description: 'changed' } } });
    assert.deepStrictEqual(resource.extensions.custom, { description: 'changed' });
    assert.ok(resource.extensions.bazaar, 'unrelated extensions survive the override');
  });

  test('financeResource overrides merge onto the base fixture', () => {
    const resource = financeResource({ url: 'https://example.com/other', payTo: 'G999' });
    assert.strictEqual(resource.url, 'https://example.com/other');
    assert.strictEqual(resource.payTo, 'G999');
    assert.strictEqual(resource.serviceName, 'Finance API');
    assert.strictEqual(financeResource().payTo, 'G123');
  });

  test('weatherTwoResource keeps its minimal footprint by default', () => {
    const resource = weatherTwoResource();
    assert.deepStrictEqual(Object.keys(resource).sort(), ['serviceName', 'type', 'url']);
    assert.strictEqual(resource.type, 'http');
  });

  test('assertSearchShape accepts a canonical response', () => {
    assert.doesNotThrow(() =>
      assertSearchShape({ resources: [], pagination: { limit: 20, cursor: null } }),
    );
  });

  test('assertSearchShape rejects a response missing pagination', () => {
    assert.throws(
      () => assertSearchShape({ resources: [] }),
      /pagination/,
      'assertSearchShape should fail when pagination is absent',
    );
  });

  test('assertSearchShape rejects a response exposing a legacy total', () => {
    assert.throws(() => assertSearchShape({ resources: [], pagination: {}, total: 3 }), /total/);
  });

  test('assertServiceNames reports the actual ordering on mismatch', () => {
    const res = { resources: [{ serviceName: 'Finance API' }, { serviceName: 'Weather API' }] };
    assert.throws(
      () => assertServiceNames(res, ['Weather API', 'Finance API'], 'ranking'),
      /ranking/,
      'assertServiceNames should include the context message',
    );
  });

  test('assertServiceNames accepts an exact ordered match', () => {
    const res = { resources: [{ serviceName: 'Weather API' }, { serviceName: 'Finance API' }] };
    assert.doesNotThrow(() => assertServiceNames(res, ['Weather API', 'Finance API']));
  });

  test('settleClock waits for the requested duration', async () => {
    const started = Date.now();
    await settleClock(15);
    assert.ok(Date.now() - started >= 14, 'settleClock should honour its delay');
  });

  test('settleClock fast path resolves without a timer', async () => {
    const started = Date.now();
    await settleClock(0);
    assert.ok(Date.now() - started < 15, 'zero delay must not wait for a timer');
  });
});

/**
 * Typed failure for the catalog search path (#374).
 *
 * A bare `TypeError` escaping `store.search()` is the failure mode this class
 * exists to remove: the caller cannot tell "the store is broken" from "I called
 * it wrong", and there is nothing stable to log or to branch on. Every failure
 * below therefore carries a `code` from {@link SEARCH_ERROR_CODES}, the params
 * that produced it, and — where there was an underlying throw — its `cause`.
 */
export class CatalogSearchError extends Error {
  constructor(message, { code, params, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CatalogSearchError';
    this.code = code;
    this.params = params;
    this.details = details;
  }
}

/** Every failure mode `safeSearch()` can report. Stable enough to branch on. */
export const SEARCH_ERROR_CODES = Object.freeze({
  INVALID_PARAMS: 'invalid_search_params',
  INVALID_QUERY: 'invalid_search_query',
  INVALID_LIMIT: 'invalid_search_limit',
  STORE_FAILED: 'search_store_failed',
  MALFORMED_RESPONSE: 'malformed_search_response',
});

/**
 * Describes why a search response is unusable, or null when it is fine.
 *
 * The store contract is `{ resources: [], pagination: {} }`; anything else is
 * a caller-visible crash waiting to happen (a `.resources.map` on undefined),
 * so it is refused here with a message that names the missing piece.
 */
function describeResponseProblem(response) {
  if (response === null || typeof response !== 'object') {
    return `expected an object, received ${response === null ? 'null' : typeof response}`;
  }
  if (!Array.isArray(response.resources)) return 'missing a resources array';
  if (!response.pagination || typeof response.pagination !== 'object') {
    return 'missing a pagination object';
  }
  return null;
}

/**
 * Runs a catalog search with the error handling the store deliberately does not
 * do: argument validation, a typed error per failure mode, and one structured
 * diagnostic carrying the code and the params.
 *
 * The store itself assumes an already-validated API boundary, which is why
 * `store.search()` with no arguments throws a bare TypeError today — that is
 * exactly the unhandled edge case this wrapper closes.
 *
 * @param {object} store - Store exposing `search(params)`.
 * @param {object} [params={}] - Search parameters.
 * @param {object} [options] - `logger` (error(msg, meta)) defaults to console.
 * @returns {Promise<object>} The store's response, unchanged.
 * @throws {CatalogSearchError} For every failure mode listed in
 *   {@link SEARCH_ERROR_CODES}; never a bare TypeError.
 */
export async function safeSearch(store, params = {}, { logger = console } = {}) {
  const fail = (code, message, details = {}) => {
    const error = new CatalogSearchError(message, { code, params, details });
    logger.error(`[CatalogSearch] ${message}`, { code, params, ...details });
    throw error;
  };

  if (!store || typeof store.search !== 'function') {
    return fail(SEARCH_ERROR_CODES.INVALID_PARAMS, 'search() requires a store exposing search()');
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return fail(SEARCH_ERROR_CODES.INVALID_PARAMS, 'search() requires a params object');
  }
  // Only a string is safe to hand to the scorer: anything truthy without
  // .trim() (a number, an object) throws inside scoreResource().
  if (params.query !== undefined && params.query !== null && typeof params.query !== 'string') {
    return fail(
      SEARCH_ERROR_CODES.INVALID_QUERY,
      `search() requires a string query, received ${typeof params.query}`,
      { received: typeof params.query },
    );
  }
  // The store slices with the limit verbatim (`slice(0, -1)` silently drops
  // the last result), so a non-positive or fractional limit is refused rather
  // than turned into a quietly wrong page.
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    return fail(
      SEARCH_ERROR_CODES.INVALID_LIMIT,
      `search() requires a positive integer limit, received ${JSON.stringify(params.limit)}`,
      { received: params.limit === undefined ? null : params.limit },
    );
  }

  let response;
  try {
    response = await store.search(params);
  } catch (cause) {
    const message = `catalog search failed: ${cause?.message ?? String(cause)}`;
    logger.error(`[CatalogSearch] ${message}`, {
      code: SEARCH_ERROR_CODES.STORE_FAILED,
      params,
      cause,
    });
    throw new CatalogSearchError(message, {
      code: SEARCH_ERROR_CODES.STORE_FAILED,
      params,
      cause,
    });
  }

  const problem = describeResponseProblem(response);
  if (problem) {
    return fail(
      SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
      `catalog search returned a malformed response: ${problem}`,
    );
  }

  return response;
}

/**
 * The fallback page: an honest empty result rather than a failed request.
 *
 * `degraded` is the tell — a caller that would rather serve "no results right
 * now" than a 500 can check it (and `reason`) without inferring anything from
 * an empty array, which a healthy search can also produce.
 */
export function degradedSearchPage(params = {}, reason = 'search_unavailable') {
  return {
    resources: [],
    partialResults: true,
    degraded: true,
    reason,
    pagination: { limit: Number.isInteger(params.limit) ? params.limit : 20, cursor: null },
  };
}

/**
 * `safeSearch()` for callers that must answer: on any failure the request gets
 * a degraded empty page, and the failure is logged once, at error level.
 *
 * An error that is not a {@link CatalogSearchError} is re-thrown rather than
 * converted — that would be a bug in the wrapper itself, and swallowing it in
 * the name of resilience is how unhandled states stay invisible.
 */
export async function searchWithFallback(store, params = {}, { logger = console } = {}) {
  try {
    return await safeSearch(store, params, { logger });
  } catch (error) {
    if (!(error instanceof CatalogSearchError)) throw error;
    logger.error(
      `[CatalogSearch] serving a degraded empty page instead of failing the request: ${error.message}`,
      { code: error.code, params },
    );
    return degradedSearchPage(params, error.code);
  }
}

/**
 * Collects `logger.error(msg, meta)` calls so a test can assert on diagnostics
 * without writing to the console.
 */
function taggedLogger() {
  const entries = [];
  return { entries, error: (message, meta) => entries.push({ level: 'error', message, meta }) };
}

/**
 * A store stand-in that records the params it was called with and returns — or
 * throws — whatever the test tells it to. Lets each failure mode below be
 * produced on demand and keeps "the store was never reached" assertable.
 */
function probeStore(behaviour) {
  const calls = [];
  return {
    calls,
    async search(params) {
      calls.push(params);
      return typeof behaviour === 'function' ? behaviour(params) : behaviour;
    },
  };
}

/**
 * #374 — every error state on the search path is explicit.
 *
 * The contract these tests pin, in the order a real request meets it:
 *
 * 1. Callers get a typed {@link CatalogSearchError} with a stable code, the
 *    params that caused it and a message that names the offending value —
 *    never the bare TypeError the store throws for an unvalidated boundary.
 * 2. A rejected call never reaches the store, so a bad request cannot be
 *    turned into store work or into half-written state.
 * 3. Exactly one diagnostic is logged per failure, carrying the code and the
 *    params; a successful call logs nothing.
 * 4. A response that cannot be served is refused here, where the message can
 *    say which part of the contract is missing.
 * 5. Callers that must answer can take the degraded empty page, which is
 *    visibly degraded rather than an empty array that looks like "no matches".
 */
test('Catalog search error handling and logging (#374)', async t => {
  await t.test(
    'a bare store.search() is the unhandled case; the wrapper returns a page',
    async () => {
      const store = await seededSearchStore();

      // The edge case this issue is about: the store assumes an API-validated
      // boundary and throws an untyped TypeError when called with nothing.
      await assert.rejects(
        () => store.search(),
        TypeError,
        'the raw store call is the unhandled exception the wrapper must absorb',
      );

      const page = await safeSearch(store, undefined, { logger: taggedLogger() });
      assert.deepStrictEqual(page.resources, [], 'a defaulted call is a well-formed empty page');
      assert.strictEqual(page.partialResults, true);
      assert.ok(page.pagination, 'the response shape is complete, not a crash');
    },
  );

  await t.test('rejects a missing or malformed store with a typed error', async () => {
    const logger = taggedLogger();
    for (const store of [null, undefined, {}, { search: 'not a function' }]) {
      await assert.rejects(
        () => safeSearch(store, { query: 'api' }, { logger }),
        err => {
          assert.strictEqual(err.name, 'CatalogSearchError');
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.INVALID_PARAMS);
          assert.match(err.message, /requires a store exposing search/);
          return true;
        },
      );
    }
    assert.strictEqual(
      logger.entries.length,
      4,
      'each rejected call logs once, and nothing else does',
    );
  });

  await t.test('rejects non-object params before the store is touched', async () => {
    for (const params of ['api', 42, true, []]) {
      const store = probeStore({ resources: [], pagination: {} });
      const logger = taggedLogger();
      await assert.rejects(
        () => safeSearch(store, params, { logger }),
        err => {
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.INVALID_PARAMS);
          assert.match(err.message, /requires a params object/);
          return true;
        },
      );
      assert.deepStrictEqual(store.calls, [], 'a rejected call must not reach the store');
      assert.strictEqual(logger.entries.length, 1, 'one failure, one diagnostic');
    }
  });

  await t.test('rejects a non-string query with the received type in the message', async () => {
    for (const query of [42, true, { term: 'api' }, ['api']]) {
      const store = probeStore({ resources: [], pagination: {} });
      const logger = taggedLogger();
      await assert.rejects(
        () => safeSearch(store, { query }, { logger }),
        err => {
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.INVALID_QUERY);
          assert.match(err.message, /requires a string query, received/);
          assert.strictEqual(err.details.received, typeof query);
          return true;
        },
      );
      assert.deepStrictEqual(store.calls, [], 'the scorer must never see a non-string query');
    }
  });

  await t.test('rejects a limit the store would silently mis-slice', async () => {
    // memory.js slices with the limit verbatim, so these are not "clamped by
    // the boundary" — they are a wrong page nobody would notice.
    for (const limit of [0, -1, 1.5, NaN, '10']) {
      const store = probeStore({ resources: [], pagination: {} });
      const logger = taggedLogger();
      await assert.rejects(
        () => safeSearch(store, { query: 'api', limit }, { logger }),
        err => {
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.INVALID_LIMIT);
          assert.match(err.message, /requires a positive integer limit/);
          return true;
        },
      );
      assert.deepStrictEqual(store.calls, []);
    }
  });

  await t.test(
    'wraps a store throw, preserving the cause and naming it in the message',
    async () => {
      const underlying = new Error('catalog table unavailable');
      const store = probeStore(() => {
        throw underlying;
      });
      const logger = taggedLogger();

      await assert.rejects(
        () => safeSearch(store, { query: 'api' }, { logger }),
        err => {
          assert.strictEqual(err.name, 'CatalogSearchError');
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.STORE_FAILED);
          assert.match(err.message, /catalog search failed: catalog table unavailable/);
          assert.strictEqual(err.cause, underlying, 'the original error must stay reachable');
          assert.deepStrictEqual(err.params, { query: 'api' });
          return true;
        },
      );
      assert.strictEqual(logger.entries.length, 1);
      assert.match(logger.entries[0].message, /catalog search failed/);
      assert.strictEqual(logger.entries[0].meta.code, SEARCH_ERROR_CODES.STORE_FAILED);
      assert.strictEqual(logger.entries[0].meta.cause, underlying);
    },
  );

  await t.test('refuses a malformed response and says which part is missing', async () => {
    const cases = [
      [null, /expected an object, received null/],
      ['a string', /expected an object, received string/],
      [{}, /missing a resources array/],
      [{ resources: {} }, /missing a resources array/],
      [{ resources: [] }, /missing a pagination object/],
    ];

    for (const [response, expected] of cases) {
      const logger = taggedLogger();
      await assert.rejects(
        () => safeSearch(probeStore(response), { query: 'api' }, { logger }),
        err => {
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.MALFORMED_RESPONSE);
          assert.match(err.message, expected);
          return true;
        },
      );
      assert.strictEqual(logger.entries.length, 1);
    }
  });

  await t.test('a successful search is returned unchanged and logs nothing', async () => {
    const response = { resources: [{ serviceName: 'Weather API' }], pagination: { cursor: null } };
    const store = probeStore(response);
    const logger = taggedLogger();
    const res = await safeSearch(store, { query: 'weather', limit: 1 }, { logger });

    assert.strictEqual(res, response, 'the wrapper must not reshape a healthy response');
    assert.deepStrictEqual(store.calls, [{ query: 'weather', limit: 1 }]);
    assert.deepStrictEqual(logger.entries, [], 'success is not a diagnostic');
  });
});

/**
 * #374 — the fallback path.
 *
 * Two guarantees: a caller that must answer gets a page it can distinguish from
 * "no matches", and a failure that is not a {@link CatalogSearchError} is not
 * swallowed — that would be a bug in this wrapper, and hiding it behind an
 * empty page is how such a bug survives.
 */
test('Catalog search fallback (#374)', async t => {
  await t.test('serves a visibly degraded empty page and logs the reason once', async () => {
    const store = probeStore(() => {
      throw new Error('catalog table unavailable');
    });
    const logger = taggedLogger();
    const page = await searchWithFallback(store, { query: 'api', limit: 5 }, { logger });

    assert.deepStrictEqual(page.resources, []);
    assert.strictEqual(page.degraded, true, 'an empty page from a failure must be marked degraded');
    assert.strictEqual(page.reason, SEARCH_ERROR_CODES.STORE_FAILED);
    assert.strictEqual(page.partialResults, true);
    assert.strictEqual(
      page.pagination.cursor,
      null,
      'a degraded page must not invite a cursor walk',
    );
    assert.strictEqual(
      page.pagination.limit,
      5,
      'the requested limit is echoed so the shape is unchanged',
    );

    assert.strictEqual(
      logger.entries.length,
      2,
      'the failure and the fallback are each reported once',
    );
    assert.match(logger.entries[1].message, /degraded empty page/);
    assert.strictEqual(logger.entries[1].meta.code, SEARCH_ERROR_CODES.STORE_FAILED);
  });

  await t.test('a degraded page is distinguishable from a healthy empty result', async () => {
    const healthy = await safeSearch(probeStore({ resources: [], pagination: { cursor: null } }));
    const degraded = degradedSearchPage({ query: 'api' }, SEARCH_ERROR_CODES.INVALID_QUERY);

    assert.strictEqual(
      healthy.degraded,
      undefined,
      'a healthy empty page carries no degraded flag',
    );
    assert.strictEqual(degraded.degraded, true);
    assert.strictEqual(
      degraded.pagination.limit,
      20,
      'the default page size applies when none was asked for',
    );
  });

  await t.test('re-throws a failure that is not a CatalogSearchError', async () => {
    const exploding = {
      error() {
        throw new Error('logger exploded');
      },
    };
    // The store has to fail for the wrapper to reach its diagnostics at all:
    // the throw below happens while reporting that failure, so it is a failure
    // the wrapper never classified.
    const store = probeStore(() => {
      throw new Error('catalog table unavailable');
    });

    await assert.rejects(
      () => searchWithFallback(store, { query: 'api' }, { logger: exploding }),
      err => {
        assert.strictEqual(err.message, 'logger exploded');
        assert.strictEqual(err instanceof CatalogSearchError, false);
        return true;
      },
      'a failure this wrapper did not classify is a bug and must not be hidden behind an empty page',
    );
  });
});
