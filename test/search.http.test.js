/**
 * Wire-level conformance for GET /discovery/search (§3.2): natural-language
 * query, cursor pagination, and the partialResults flag. The store-level
 * behaviour is covered in test/catalog.search.test.js; these tests pin the
 * response the client actually sees.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogStore } from '../src/catalog/memory.js';
import { serve } from './helpers/app.js';

const WEATHER = {
  url: 'https://api.weather.example/v1',
  type: 'http',
  serviceName: 'Global Weather API',
  description: 'Weather forecasts for any latitude and longitude.',
  tags: ['weather', 'forecast', 'climate'],
  payTo: 'GWEATHER',
  scheme: 'exact',
  network: 'stellar:testnet',
  extensions: { bazaar: { parameters: { lat: 'Latitude', lon: 'Longitude' } } },
};

const FINANCE = {
  url: 'https://api.finance.example/v2',
  type: 'http',
  serviceName: 'Currency Converter',
  description: 'Convert fiat currencies at real-time rates via a REST API.',
  tags: ['finance', 'currency'],
  payTo: 'GFINANCE',
  scheme: 'exact',
  network: 'stellar:testnet',
};

const JOKE = {
  url: 'https://api.joke.example/v1',
  type: 'http',
  serviceName: 'Dad Joke Generator',
  description: 'A random dad joke served over a simple API.',
  tags: ['joke', 'fun'],
  payTo: 'GJOKE',
  scheme: 'exact',
  network: 'stellar:testnet',
};

/** A catalog preloaded with three resources, ordered so pagination is stable. */
async function makeCatalog() {
  const catalog = new MemoryCatalogStore(); // no EMBEDDINGS_URL: lexical leg only
  await catalog.upsertResource(WEATHER, 'payment');
  await new Promise(r => setTimeout(r, 10));
  await catalog.upsertResource(FINANCE, 'payment');
  await new Promise(r => setTimeout(r, 10));
  await catalog.upsertResource(JOKE, 'manual');
  return catalog;
}

describe('GET /discovery/search — spec conformance', () => {
  let app;
  let catalog;

  before(async () => {
    catalog = await makeCatalog();
    app = await serve({ catalog });
  });
  after(() => app.close());

  test('conforms to the response shape (x402Version, resources, partialResults, pagination)', async () => {
    const res = await app.get('/discovery/search?query=api');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.x402Version, 2);
    assert.ok(Array.isArray(json.resources));
    assert.equal(typeof json.partialResults, 'boolean');
    assert.ok(json.pagination, 'pagination is required');
    assert.equal(typeof json.pagination.limit, 'number');
    // cursor is a string or null — never omitted.
    assert.ok(
      json.pagination.cursor === null || typeof json.pagination.cursor === 'string',
      'pagination.cursor must be a string or null',
    );
  });

  test('partialResults is true when no embeddings provider is configured', async () => {
    // The semantic leg is absent, so the result set is honestly partial even
    // though the lexical leg is complete.
    const res = await app.get('/discovery/search?query=weather');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.partialResults, true);
  });

  test('partialResults is true when the provider is configured but a resource is not embedded', async () => {
    // A configured-but-unembedded catalog is the degraded state partialResults
    // exists to name: the top-N may not be the true top-N.
    const mockEmbeds = new MemoryCatalogStore({ embeddingsUrl: 'http://127.0.0.1:1/embed' });
    await mockEmbeds.upsertResource(WEATHER, 'payment');
    const app2 = await serve({ catalog: mockEmbeds });
    try {
      const res = await app2.get('/discovery/search?query=weather');
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.partialResults, true);
    } finally {
      await app2.close();
    }
  });

  test('cursor pagination walks the whole result set exactly once', async () => {
    const res = await app.get('/discovery/search?query=api&limit=1');
    assert.equal(res.status, 200);
    const page1 = await res.json();
    assert.equal(page1.resources.length, 1);
    assert.ok(page1.pagination.cursor, 'a non-final page must return a cursor');

    const page2res = await app.get(
      `/discovery/search?query=api&limit=1&cursor=${encodeURIComponent(page1.pagination.cursor)}`,
    );
    const page2 = await page2res.json();
    assert.equal(page2.resources.length, 1);
    assert.notEqual(page1.resources[0].url, page2.resources[0].url);

    const page3res = await app.get(
      `/discovery/search?query=api&limit=1&cursor=${encodeURIComponent(page2.pagination.cursor)}`,
    );
    const page3 = await page3res.json();
    assert.equal(page3.resources.length, 1);
    assert.notEqual(page1.resources[0].url, page3.resources[0].url);
    assert.notEqual(page2.resources[0].url, page3.resources[0].url);
    // Final page: no next cursor.
    assert.equal(page3.pagination.cursor, null);

    const seen = [page1.resources[0].url, page2.resources[0].url, page3.resources[0].url];
    assert.equal(new Set(seen).size, 3, 'cursor pagination must not repeat or skip entries');
  });

  test('a garbage cursor is treated as page one, not an error', async () => {
    const res = await app.get('/discovery/search?query=api&cursor=%00%01%02garbage');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.resources.length >= 1);
  });

  test('an omitted query is a 400 naming the reason', async () => {
    const res = await app.get('/discovery/search');
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'invalid_request');
    assert.equal(json.reason, 'query is required');
  });
});
