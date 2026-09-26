/**
 * @file Documentation-first tests for catalog search behaviour.
 *
 * Covers the contract of {@link MemoryCatalogStore#search}: response shape,
 * filter composition, extension indexing, source-based ranking, cursor
 * pagination, and the truthfulness of the `partialResults` flag when no
 * embedding provider is configured.
 *
 * Every public interface below follows TSDoc-style block comments so the
 * business intent is legible without reading the implementation.
 */
import test from 'node:test';
import assert from 'node:assert';
import { MemoryCatalogStore } from '../src/catalog/memory.js';

/**
 * Catalog search suite.
 *
 * Seeds a shared {@link MemoryCatalogStore} with two baseline resources:
 *
 * 1. "Weather API" — ingested from the `payment` stream, carrying a `custom`
 *    extension whose description contains indexed free-text ("secret token").
 * 2. "Finance API" — ingested from the `manual` stream.
 *
 * The subtests are order-dependent by design: later cases (ranking,
 * pagination) rely on fixtures introduced by earlier ones, so they run
 * sequentially against the same store instance.
 *
 * @param t - Node test context used to register the nested subtests.
 */
test('Catalog search tests', async t => {
  const store = new MemoryCatalogStore();

  // Baseline fixture 1: a payment-sourced weather API whose `custom`
  // extension description is indexed for free-text search.
  await store.upsertResource(
    {
      url: 'https://example.com/api',
      serviceName: 'Weather API',
      description: 'Get current weather',
      tags: ['weather', 'forecast'],
      type: 'http',
      payTo: 'G123',
      scheme: 'exact',
      network: 'stellar:pubnet',
      extensions: {
        bazaar: { info: 'bazaar config' },
        custom: { description: 'secret token parameter' },
      },
    },
    'payment',
  );

  // Separate the two upserts so first_seen_at differs; ranking falls back to
  // recency when relevance ties, so identical timestamps would be flaky.
  await new Promise(r => setTimeout(r, 10)); // Ensure different first_seen_at

  // Baseline fixture 2: a manually catalogued finance API.
  await store.upsertResource(
    {
      url: 'https://example.com/api2',
      serviceName: 'Finance API',
      description: 'Get stock prices',
      tags: ['finance', 'stock'],
      type: 'http',
      payTo: 'G123',
      scheme: 'exact',
      network: 'stellar:pubnet',
    },
    'manual',
  );

  /**
   * Asserts the search response conforms to the discovery contract:
   * `resources` array + `pagination` object, and no legacy `total` field.
   *
   * `partialResults` must be `true` here because no embedding provider is
   * configured — the store falls back to keyword matching and says so.
   */
  await t.test('conforms to response shape', async () => {
    const res = await store.search({ query: 'api' });
    assert.ok(res.resources, 'Has resources array');
    assert.ok(res.pagination, 'Has pagination');
    assert.strictEqual(res.total, undefined, 'Does not have total');
    assert.strictEqual(res.resources.length, 2);
    assert.strictEqual(res.partialResults, true); // true because no embedding provider is configured
  });

  /**
   * Proves extension filters compose with (rather than replace) the
   * free-text query: only the resource advertising the `custom` extension
   * survives, even though both match the query text.
   */
  await t.test('filters compose with query', async () => {
    const res = await store.search({ query: 'api', extensions: ['custom'] });
    assert.strictEqual(res.resources.length, 1);
    assert.strictEqual(res.resources[0].serviceName, 'Weather API');
  });

  /**
   * Proves extension values are part of the search index: querying free text
   * that appears only inside the `custom` extension description still
   * surfaces the owning resource.
   */
  await t.test('extensions are indexed', async () => {
    const res = await store.search({ query: 'secret token' });
    assert.strictEqual(res.resources.length, 1);
    assert.strictEqual(res.resources[0].serviceName, 'Weather API');
  });

  /**
   * Proves source-based ranking: when two resources match equally well, the
   * one ingested from the `payment` stream outranks the `manual` one.
   *
   * Adds a third fixture inline so the tie-break is observable.
   */
  await t.test('ranking: payment outranks manual', async () => {
    await store.upsertResource(
      {
        url: 'https://example.com/api3',
        serviceName: 'Weather API 2',
        type: 'http',
      },
      'manual',
    );
    const res = await store.search({ query: 'weather' });
    assert.strictEqual(res.resources[0].serviceName, 'Weather API');
    assert.strictEqual(res.resources[1].serviceName, 'Weather API 2');
  });

  /**
   * Proves opaque cursor pagination: consecutive `limit: 1` pages must
   * return distinct resources, walked via `pagination.cursor`.
   */
  await t.test('cursor pagination works', async () => {
    // Should get first page
    const page1 = await store.search({ query: 'api', limit: 1 });
    assert.strictEqual(page1.resources.length, 1);
    assert.ok(page1.pagination.cursor, 'First page returns cursor');

    // Should get second page using cursor
    const page2 = await store.search({ query: 'api', limit: 1, cursor: page1.pagination.cursor });
    assert.strictEqual(page2.resources.length, 1);
    assert.notStrictEqual(page1.resources[0].url, page2.resources[0].url);
  });

  /**
   * Truth-in-advertising check on `partialResults`: with no embedding
   * provider available the store must flag the result set as partial rather
   * than silently implying exhaustive semantic recall.
   */
  await t.test('partialResults is truthful (true when provider is unavailable)', async () => {
    const res = await store.search({ query: 'api' });
    assert.strictEqual(res.partialResults, true);
  });
});
