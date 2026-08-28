import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, testConfig } from './helpers/app.js';
import { MemoryCatalogStore } from '../src/catalog/memory.js';

/**
 * #200: the discovery reads are the polled half of the service. Both routes
 * send Cache-Control (configurable max-age + stale-while-revalidate) and a
 * weak ETag derived from the store's monotonic catalog version, honour
 * If-None-Match with an empty 304, and compute the validators BEFORE the
 * expensive listing/scoring work — so a poll that is unchanged costs a header
 * comparison, not a re-run of the ranking path.
 */

const LISTING = {
  type: 'http',
  url: 'https://api.example.test/weather',
  payTo: 'GCACHEPAYTO1111111111111111111111111111111111111111111111',
  scheme: 'exact',
  network: 'stellar:testnet',
  x402Version: 2,
  first_seen_at: new Date('2026-08-01T00:00:00Z'),
};

async function cachedServe(config) {
  const store = new MemoryCatalogStore();
  const handle = await serve({ catalog: store, config });
  return { ...handle, store };
}

test('#200: both discovery routes send Cache-Control and a weak ETag', async t => {
  const h = await cachedServe();
  t.after(() => h.close());

  for (const path of ['/discovery/resources', '/discovery/search?query=weather']) {
    const res = await h.get(path);
    assert.equal(res.status, 200, path);
    assert.match(
      res.headers.get('cache-control'),
      /^public, max-age=\d+, stale-while-revalidate=\d+$/,
      `cache-control on ${path}`,
    );
    assert.match(res.headers.get('etag'), /^W\/"\d+-[A-Za-z0-9_-]+"$/, `weak etag on ${path}`);
    assert.ok(res.headers.get('last-modified'), `last-modified on ${path}`);
  }
});

test('#200: a repeat request with If-None-Match gets an empty 304', async t => {
  const h = await cachedServe();
  t.after(() => h.close());

  const first = await h.get('/discovery/resources?limit=5');
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');

  const again = await h.get('/discovery/resources?limit=5', { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal((await again.text()).length, 0, '304 carries no body');

  // A validator from a DIFFERENT representation must not produce a 304.
  const other = await h.get('/discovery/resources?limit=100', { 'if-none-match': etag });
  assert.equal(other.status, 200, 'validators do not leak across query variants');
});

test('#200: any catalog write invalidates the validator', async t => {
  const h = await cachedServe();
  t.after(() => h.close());

  const before = (await h.get('/discovery/resources')).headers.get('etag');

  // Every write path funnels through the store — a settled payment, a manual
  // registration, and this test — so bumping the version on upsert covers
  // them all.
  await h.store.upsertResource({ ...LISTING }, 'manual');

  const after = await h.get('/discovery/resources');
  assert.equal(after.status, 200, 'the pre-write validator no longer matches');
  assert.notEqual(after.headers.get('etag'), before, 'the etag changed');

  const stale = await h.get('/discovery/resources', { 'if-none-match': before });
  assert.equal(stale.status, 200, 'a pre-write etag must not 304 after a write');
});

test('#200: the validator keys on the full parameter set', async t => {
  const h = await cachedServe();
  t.after(() => h.close());
  await h.store.upsertResource({ ...LISTING }, 'manual');

  const plain = (await h.get('/discovery/resources')).headers.get('etag');
  const filtered = (await h.get('/discovery/resources?network=stellar:testnet')).headers.get(
    'etag',
  );
  const extensions = (await h.get('/discovery/resources?extensions=some-extension')).headers.get(
    'etag',
  );

  assert.notEqual(plain, filtered, 'a filter changes the representation');
  assert.notEqual(plain, extensions, 'extensions change the representation');
  assert.notEqual(filtered, extensions);
});

test('#200: search revalidates the same way', async t => {
  const h = await cachedServe();
  t.after(() => h.close());

  const first = await h.get('/discovery/search?query=weather&limit=10');
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');

  const again = await h.get('/discovery/search?query=weather&limit=10', { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal((await again.text()).length, 0);
});

test('#200: the cache policy is configurable, not hardcoded', async t => {
  const config = {
    ...testConfig(),
    discoveryCache: { maxAgeSeconds: 5, staleWhileRevalidateSeconds: 30 },
  };
  const h = await cachedServe(config);
  t.after(() => h.close());

  const res = await h.get('/discovery/resources');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=5, stale-while-revalidate=30');
});
