import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CatalogSearchCache,
  LruTtlCache,
  withSearchCache,
  DEFAULT_INVALIDATION_CHANNEL,
} from '../src/catalog/cache.js';
import { searchCacheKey } from '../src/catalog/search.js';

/**
 * ioredis stand-in with real GET/SET/EXPIRE/PUBLISH semantics against a Map,
 * plus a working `duplicate()` so the Pub/Sub path is exercised rather than
 * stubbed. Deliberately no server and no network.
 */
function fakeRedis() {
  const store = new Map(); // key -> { value, expiresAt }
  const channels = new Map(); // channel -> Set<subscriber>
  const published = [];
  const log = [];

  const client = {
    store,
    published,
    log,
    status: 'ready',
    on: () => {},
    _live() {
      return this;
    },
    async get(key) {
      log.push(['get', key]);
      if (client.status === 'end') throw new Error('Connection is closed.');
      if (client.failing)
        throw new Error('READONLY You can not write against a read only replica.');
      const entry = store.get(key);
      if (!entry || entry.expiresAt <= Date.now()) return null;
      return entry.value;
    },
    async set(key, value, ...rest) {
      log.push(['set', key, value, ...rest]);
      if (client.status === 'end') throw new Error('Connection is closed.');
      if (client.failing)
        throw new Error('READONLY You can not write against a read only replica.');
      const ex = rest.indexOf('EX');
      const ttlSec = ex >= 0 ? Number(rest[ex + 1]) : 60;
      store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
      return 'OK';
    },
    async publish(channel, message) {
      log.push(['publish', channel, message]);
      published.push({ channel, message });
      // Real ioredis delivers a Pub/Sub message by emitting 'message'; there is
      // no onMessage method. The fake routes through the registered listener so
      // the cache's real event wiring is what gets exercised.
      for (const sub of channels.get(channel) ?? []) sub.emit('message', channel, message);
      return 1;
    },
    async subscribe(channel) {
      log.push(['subscribe', channel]);
      return 1;
    },
    async unsubscribe() {
      return 1;
    },
    duplicate() {
      const sub = makeEndpoint();
      sub.subscribe = async channel => {
        if (!channels.has(channel)) channels.set(channel, new Set());
        channels.get(channel).add(sub);
        log.push(['subscribe', channel]);
        return 1;
      };
      sub.unsubscribe = async channel => {
        channels.get(channel)?.delete(sub);
        return 1;
      };
      sub.quit = async () => {
        log.push(['quit']);
        return 'OK';
      };
      return sub;
    },
    async quit() {
      log.push(['quit']);
      return 'OK';
    },
    /** Test hook: mark the connection dead, the way a Redis outage would. */
    break_() {
      client.status = 'end';
    },
    /**
     * Test hook: the connection still *looks* ready but every command fails —
     * the mid-flight case the try/catch exists for, as opposed to `break_`.
     */
    failCommands_() {
      client.status = 'ready';
      client.failing = true;
    },
  };
  return client;
}

/** An endpoint that records event listeners and replays them, like an EventEmitter. */
function makeEndpoint() {
  const listeners = new Map();
  return {
    status: 'ready',
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return this;
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };
}

/** Minimal store that counts searches and bumps a write version on upsert. */
function fakeStore({ results = null } = {}) {
  const state = { version: 0, searches: 0, lastParams: null, resources: [] };
  return {
    state,
    getVersion: () => state.version,
    getLastModified: () => new Date(state.version),
    async search(params) {
      state.searches += 1;
      state.lastParams = params;
      if (results) return results;
      return {
        resources: state.resources,
        partialResults: true,
        pagination: { cursor: null },
        echo: params.query,
      };
    },
    async upsertResource(resource) {
      state.resources.push(resource);
      state.version += 1;
      return resource;
    },
    async getResource() {
      return null;
    },
    async listResources() {
      return { items: state.resources, total: state.resources.length };
    },
    async pruneExpired() {
      return 0;
    },
    async flush() {},
  };
}

test('LruTtlCache', async t => {
  await t.test('evicts the least recently used entry, not the oldest', () => {
    const cache = new LruTtlCache({ maxEntries: 2, ttlMs: 1000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' is now the most recent, so 'b' is the coldest
    cache.set('c', 3);

    assert.equal(cache.size, 2);
    assert.equal(cache.get('a'), 1, 'the recently-read entry survives');
    assert.equal(cache.get('b'), undefined, 'the coldest entry was evicted');
    assert.equal(cache.get('c'), 3);
  });

  await t.test('expires an entry once its TTL elapses', () => {
    let now = 1_000_000;
    const cache = new LruTtlCache({ maxEntries: 10, ttlMs: 5000, now: () => now });
    cache.set('a', 'v');
    assert.equal(cache.get('a'), 'v');

    now += 4999;
    assert.equal(cache.get('a'), 'v', 'still live one millisecond before expiry');

    now += 2;
    assert.equal(cache.get('a'), undefined, 'gone after the TTL');
    assert.equal(cache.size, 0, 'an expired entry is dropped, not left to rot');
  });

  await t.test('overwrites in place without double-counting capacity', () => {
    const cache = new LruTtlCache({ maxEntries: 2, ttlMs: 1000 });
    cache.set('a', 1);
    cache.set('a', 2);
    cache.set('b', 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.get('a'), 2);
  });
});

test('searchCacheKey', async t => {
  await t.test('is order-independent for the same question', () => {
    assert.equal(
      searchCacheKey({ query: 'api', limit: 5 }),
      searchCacheKey({ limit: 5, query: 'api' }),
    );
  });

  await t.test('treats an absent limit as the store default', () => {
    // search() defaults limit to 20, so these are one question, not two.
    assert.equal(searchCacheKey({ query: 'api' }), searchCacheKey({ query: 'api', limit: 20 }));
  });

  await t.test('ignores query case and padding, which the scorer ignores', () => {
    assert.equal(searchCacheKey({ query: ' API ' }), searchCacheKey({ query: 'api' }));
  });

  await t.test('separates different limits, queries and cursors', () => {
    const base = searchCacheKey({ query: 'api', limit: 5 });
    assert.notEqual(base, searchCacheKey({ query: 'api', limit: 6 }));
    assert.notEqual(base, searchCacheKey({ query: 'weather', limit: 5 }));
    // Page 2 is a different result set; conflating them serves page 1 twice.
    assert.notEqual(base, searchCacheKey({ query: 'api', limit: 5, cursor: 'offset:20' }));
  });

  await t.test('is order-independent for extension filters', () => {
    assert.equal(
      searchCacheKey({ query: 'api', extensions: ['b', 'a'] }),
      searchCacheKey({ query: 'api', extensions: ['a', 'b'] }),
    );
    assert.notEqual(
      searchCacheKey({ query: 'api', extensions: ['a'] }),
      searchCacheKey({ query: 'api', extensions: ['a', 'b'] }),
    );
  });

  await t.test('separates every filter the store supports', () => {
    // The regression this guards: a filter missing from the key is not a smaller
    // cache but a wrong one — a pubnet-filtered caller served a testnet entry
    // gets a list of payees on the wrong network.
    for (const param of ['type', 'payTo', 'scheme', 'network']) {
      const base = searchCacheKey({ query: 'api' });
      assert.notEqual(
        base,
        searchCacheKey({ query: 'api', [param]: 'different' }),
        `${param} must be part of the key`,
      );
      // A falsy value is what the store treats as "no narrowing"
      // (`if (params.type)`), so it must collapse onto the unfiltered key
      // rather than opening a second namespace for the same question.
      assert.equal(
        base,
        searchCacheKey({ query: 'api', [param]: '' }),
        `an empty ${param} is the same question as omitting it`,
      );
    }
    assert.notEqual(
      searchCacheKey({ query: 'api' }),
      searchCacheKey({ query: 'api', offset: 20 }),
      'offset selects a different slice and must be part of the key',
    );
  });

  await t.test('separates the two networks that must never be conflated', () => {
    // Spelled out because this is the pair that matters: a cross-network hit
    // points an agent at payees it cannot pay.
    assert.notEqual(
      searchCacheKey({ query: 'api', network: 'stellar:testnet' }),
      searchCacheKey({ query: 'api', network: 'stellar:pubnet' }),
    );
  });

  await t.test('every param the store can filter on is in the key', () => {
    // Read the filter list straight off the store, so adding a filter there
    // without adding it to the key fails here rather than in production.
    const source = readFileSync(new URL('../src/catalog/memory.js', import.meta.url), 'utf8');
    const filtered = [...source.matchAll(/if \(params\.([a-zA-Z]+)\)\s*items\s*=/g)].map(m => m[1]);
    assert.ok(
      filtered.length >= 4,
      `expected the store to filter on >=4 params, saw ${filtered.length}`,
    );

    for (const param of filtered) {
      assert.notEqual(
        searchCacheKey({ query: 'api' }),
        searchCacheKey({ query: 'api', [param]: 'zzz' }),
        `CatalogStore filters on ${param} but searchCacheKey ignores it`,
      );
    }
  });
});

test('CatalogSearchCache L1', async t => {
  await t.test('serves a repeat query from memory without touching the store', async () => {
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store });

    const first = await cache.search({ query: 'api' });
    const second = await cache.search({ query: 'api' });

    assert.equal(store.state.searches, 1, 'the second lookup must not reach the store');
    assert.deepEqual(second, first);
    assert.equal(second.echo, 'api', 'the cached value is the store result, unmodified');
    assert.equal(cache.stats().l1.hit, 1);
    assert.equal(cache.stats().l1.miss, 1);
    assert.equal(cache.stats().l1.ratio, 0.5);
  });

  await t.test('reports a null ratio before anything is decided', () => {
    // A cold cache must not scrape as a 0% hit rate.
    assert.equal(new CatalogSearchCache({ store: fakeStore() }).stats().l1.ratio, null);
  });

  await t.test('a store write makes the previous generation unreachable at once', async () => {
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store, l1TtlMs: 60_000 });

    await cache.search({ query: 'api' });
    assert.equal(cache.stats().l1.size, 1);

    store.state.version = 1; // as upsertResource would
    store.state.resources = [{ url: 'https://new.example' }];

    const after = await cache.search({ query: 'api' });
    assert.equal(store.state.searches, 2, 'a new version must not be answered from the old entry');
    assert.equal(after.resources[0].url, 'https://new.example');
  });

  await t.test('collapses concurrent misses for the same key into one store call', async () => {
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store });

    // The L1's 5s window is also a stampede window without single-flight.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => cache.search({ query: 'api' })),
    );

    assert.equal(store.state.searches, 1, 'a cold key must not stampede the store');
    for (const r of results) assert.deepEqual(r, results[0]);
    assert.equal(cache.stats().inflight, 0, 'the in-flight table must not leak entries');
  });

  await t.test('does not collapse different keys into one call', async () => {
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store });
    await Promise.all([cache.search({ query: 'a' }), cache.search({ query: 'b' })]);
    assert.equal(store.state.searches, 2);
  });

  await t.test('a failed store search is not cached', async () => {
    let calls = 0;
    const store = {
      getVersion: () => 0,
      async search() {
        calls += 1;
        if (calls === 1) throw new Error('catalog unavailable');
        return { resources: [], partialResults: true };
      },
    };
    const cache = new CatalogSearchCache({ store });

    await assert.rejects(() => cache.search({ query: 'api' }), /catalog unavailable/);
    // Poisoning the cache with a failure would turn a transient outage into a
    // sticky one for the whole TTL.
    const ok = await cache.search({ query: 'api' });
    assert.deepEqual(ok.resources, []);
    assert.equal(calls, 2);
    assert.equal(cache.stats().inflight, 0, 'a rejection must clear the in-flight slot');
  });
});

test('CatalogSearchCache L2', async t => {
  await t.test('a miss on L1 is answered by Redis, not the store', async () => {
    const redis = fakeRedis();
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store, redis });

    const cold = await cache.search({ query: 'api' });
    assert.equal(store.state.searches, 1);

    // A different replica sharing the same Redis, with its own cold L1.
    const peer = new CatalogSearchCache({ store: fakeStore(), redis });
    const warm = await peer.search({ query: 'api' });

    assert.equal(peer.store.state.searches, 0, 'the peer must not query the store');
    assert.deepEqual(warm, cold);
    assert.equal(cache.stats().l2.miss, 1);
    assert.equal(peer.stats().l2.hit, 1);
  });

  await t.test('writes L2 with the configured TTL', async () => {
    const redis = fakeRedis();
    const cache = new CatalogSearchCache({ store: fakeStore(), redis, l2TtlSec: 60 });
    await cache.search({ query: 'api' });

    const setCall = redis.log.find(e => e[0] === 'set');
    assert.ok(setCall, 'the result must be published to L2');
    assert.deepEqual(setCall.slice(3), ['EX', 60], 'L2 entries expire');
  });

  await t.test('a corrupt L2 entry degrades to a store read, not a 500', async () => {
    const redis = fakeRedis();
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store, redis });
    await cache.search({ query: 'api' });

    // Something else wrote to our key namespace.
    const key = [...redis.store.keys()][0];
    redis.store.set(key, { value: 'not json', expiresAt: Date.now() + 60_000 });

    const peerStore = fakeStore();
    const peer = new CatalogSearchCache({ store: peerStore, redis });
    const res = await peer.search({ query: 'api' });
    assert.deepEqual(res.resources, [], 'falls through to the store');
    assert.equal(peerStore.state.searches, 1);
  });

  await t.test('a dead Redis connection disables L2 without erroring', async () => {
    const redis = fakeRedis();
    const store = fakeStore();
    const warns = [];
    const cache = new CatalogSearchCache({ store, redis, warn: m => warns.push(m) });

    await cache.search({ query: 'api' }); // populates L2
    redis.break_();

    const peerStore = fakeStore();
    const peer = new CatalogSearchCache({ store: peerStore, redis, warn: m => warns.push(m) });
    const res = await peer.search({ query: 'api' });

    // A cache outage must never become a discovery outage.
    assert.equal(peerStore.state.searches, 1, 'falls through to the store');
    assert.deepEqual(res.resources, []);
    assert.equal(peer.stats().l2.enabled, false);
    // A connection known to be dead is not even dialled, so this is not an
    // error and not a miss — `l2.enabled` is what tells the operator why.
    assert.equal(peer.stats().l2.error, 0);
    assert.equal(peer.stats().l2.miss, 0);
    assert.deepEqual(warns, [], 'a disabled cache is not worth a warning per request');
  });

  await t.test('a Redis command that fails mid-flight degrades and warns once', async () => {
    const redis = fakeRedis();
    redis.failCommands_();
    const store = fakeStore();
    const warns = [];
    const cache = new CatalogSearchCache({ store, redis, warn: m => warns.push(m) });

    const res = await cache.search({ query: 'api' });

    // Same contract: the caller still gets a result.
    assert.deepEqual(res.resources, []);
    assert.equal(store.state.searches, 1);
    assert.equal(cache.stats().l2.error, 1, 'a failure is not laundered into a miss');
    assert.ok(
      warns.some(m => /L2 read failed/.test(m)),
      warns.join('\n'),
    );

    // And the connection is marked unusable, so the outage is not re-dialled
    // (nor re-warned) on every subsequent request.
    const warnsAfter = warns.length;
    await cache.search({ query: 'weather' });
    assert.equal(store.state.searches, 2, 'later lookups still reach the store');
    assert.equal(warns.length, warnsAfter, 'one line per outage, not one per request');
  });

  await t.test('works with no Redis configured at all', async () => {
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store });
    await cache.search({ query: 'api' });
    await cache.search({ query: 'api' });
    assert.equal(store.state.searches, 1, 'L1 alone still absorbs repeats');
    assert.equal(cache.stats().l2.enabled, false);
  });
});

test('CatalogSearchCache invalidation', async t => {
  await t.test('publishes to the shared channel and clears local L1', async () => {
    const redis = fakeRedis();
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store, redis, l1TtlMs: 60_000 });

    await cache.search({ query: 'api' });
    assert.equal(cache.stats().l1.size, 1);

    store.state.version = 7;
    await cache.invalidate({ reason: 'catalog write' });

    assert.equal(cache.stats().l1.size, 0, 'L1 is dropped on invalidation');
    assert.equal(redis.published.length, 1);
    assert.equal(redis.published[0].channel, DEFAULT_INVALIDATION_CHANNEL);
    assert.equal(JSON.parse(redis.published[0].message).version, 7);
  });

  await t.test('a peer drops its L1 when it receives the broadcast', async () => {
    const redis = fakeRedis();
    const writer = new CatalogSearchCache({ store: fakeStore(), redis });
    const peerStore = fakeStore();
    const peer = new CatalogSearchCache({ store: peerStore, redis, l1TtlMs: 60_000 });

    await writer.start();
    await peer.start();

    await peer.search({ query: 'api' });
    await peer.search({ query: 'api' });
    assert.equal(peerStore.state.searches, 1);
    assert.equal(peer.stats().l1.size, 1);

    // The writer's store moves on, then broadcasts.
    writer.store.state.version = 1;
    await writer.invalidate({ reason: 'catalog write' });

    assert.equal(peer.stats().l1.size, 0, 'the peer must not keep serving its old generation');
    await peer.search({ query: 'api' });
    assert.equal(peerStore.state.searches, 2, 'the peer re-reads after the invalidation');

    await peer.stop();
    await writer.stop();
  });

  await t.test('a peer refuses an L2 entry from a retired generation', async () => {
    // Pub/Sub is lossy. If a peer misses the broadcast, the version floor is
    // what stops it serving a generation that is already retired.
    const redis = fakeRedis();
    const seed = new CatalogSearchCache({ store: fakeStore(), redis });
    await seed.search({ query: 'api' }); // writes L2 at version 0

    const peerStore = fakeStore();
    const peer = new CatalogSearchCache({ store: peerStore, redis, l1TtlMs: 60_000 });
    // The peer has already learned that version 5 exists from elsewhere.
    peer.minValidVersion = 5;
    peer.lastSeenVersion = 5;

    const res = await peer.search({ query: 'api' });

    assert.equal(peerStore.state.searches, 1, 'the retired L2 entry must not be served');
    assert.deepEqual(res.resources, [], 'the store answered instead');
    assert.equal(peer.stats().l2.hit, 0, 'a key known to be stale is not even fetched');
    assert.equal(peer.stats().l1.size, 0, 'and it is not re-admitted into the live generation');
  });

  await t.test('a malformed broadcast is ignored, not fatal', async () => {
    const redis = fakeRedis();
    const store = fakeStore();
    const cache = new CatalogSearchCache({ store, redis, l1TtlMs: 60_000 });
    await cache.search({ query: 'api' });

    cache._onMessage(DEFAULT_INVALIDATION_CHANNEL, 'not json');
    cache._onMessage(DEFAULT_INVALIDATION_CHANNEL, JSON.stringify({ version: 'x' }));
    cache._onMessage('some:other:channel', JSON.stringify({ version: 99 }));

    assert.equal(
      cache.stats().l1.size,
      1,
      'a foreign or unparseable message must not drop the cache',
    );
  });

  await t.test('invalidate is safe with no Redis', async () => {
    const cache = new CatalogSearchCache({ store: fakeStore() });
    await cache.search({ query: 'api' });
    await assert.doesNotReject(() => cache.invalidate());
    assert.equal(cache.stats().l1.size, 0);
  });

  await t.test('stop releases the subscriber', async () => {
    const redis = fakeRedis();
    const cache = new CatalogSearchCache({ store: fakeStore(), redis });
    await cache.start();
    await cache.stop();
    assert.equal(cache.subscriber, null);
    assert.ok(
      redis.log.some(e => e[0] === 'quit'),
      'the duplicate connection is closed',
    );
  });
});

test('withSearchCache decorator', async t => {
  await t.test('caches search and passes every other method through', async () => {
    const store = fakeStore();
    const cached = withSearchCache(store, { warn: () => {} });

    assert.equal(typeof cached.getResource, 'function');
    assert.equal(typeof cached.getVersion, 'function');
    assert.equal(typeof cached.pruneExpired, 'function');
    assert.equal(cached.getVersion(), 0);

    await cached.search({ query: 'api' });
    await cached.search({ query: 'api' });
    assert.equal(store.state.searches, 1, 'search is cached');
    assert.equal(cached.getVersion(), 0, 'the other methods are the underlying store');
    assert.equal(cached.searchCache.inflight.size, 0);
  });

  await t.test('exposes invalidate so a write path can announce itself', async () => {
    const store = fakeStore();
    const cached = withSearchCache(store, { warn: () => {} });
    await cached.search({ query: 'api' });
    await cached.invalidate({ reason: 'test' });
    assert.equal(cached.searchCache.stats().l1.size, 0);
  });

  await t.test('a plain store is unaffected when no options are given', async () => {
    const store = fakeStore();
    assert.equal(store.searchCache, undefined);
  });
});

test('catalog search cache metrics', async () => {
  const lookups = [];
  const store = fakeStore();
  const cache = new CatalogSearchCache({
    store,
    redis: fakeRedis(),
    onLookup: l => lookups.push(l),
  });

  await cache.search({ query: 'api' }); // l1 miss, l2 miss
  await cache.search({ query: 'api' }); // l1 hit
  const peer = new CatalogSearchCache({
    store: fakeStore(),
    redis: cache.redis,
    onLookup: l => lookups.push(l),
  });
  await peer.search({ query: 'api' }); // l1 miss, l2 hit

  assert.deepEqual(
    lookups.filter(l => l.tier === 'l1'),
    [
      { tier: 'l1', outcome: 'miss' },
      { tier: 'l1', outcome: 'hit' },
      { tier: 'l1', outcome: 'miss' },
    ],
  );
  assert.deepEqual(
    lookups.filter(l => l.tier === 'l2'),
    [
      { tier: 'l2', outcome: 'miss' },
      { tier: 'l2', outcome: 'hit' },
    ],
  );

  // The same tally, rendered as Prometheus text.
  const { createMetrics } = await import('../src/metrics.js');
  const metrics = createMetrics();
  for (const l of lookups) metrics.incCatalogCacheLookup(l);
  const text = metrics.render();
  assert.match(text, /# TYPE x402_catalog_cache_lookups_total counter/);
  // Labels render in the order the series declares them, not sorted.
  assert.match(text, /x402_catalog_cache_lookups_total\{tier="l1",outcome="hit"\} 1/);
  assert.match(text, /x402_catalog_cache_lookups_total\{tier="l1",outcome="miss"\} 2/);
  assert.match(text, /x402_catalog_cache_lookups_total\{tier="l2",outcome="hit"\} 1/);
});

test('a metrics sink that throws cannot fail a discovery request', async () => {
  const cache = new CatalogSearchCache({
    store: fakeStore(),
    onLookup: () => {
      throw new Error('registry exploded');
    },
  });
  const res = await cache.search({ query: 'api' });
  assert.ok(res, 'a broken metrics sink must not take discovery down');
  assert.equal(cache.stats().l1.miss, 1, 'the internal tally still counted it');
});

test('every catalog write path announces itself to peer replicas', async t => {
  // The failure this guards is a freshness gap rather than a wrong answer: a
  // write on one replica is correct there immediately (the version that keys
  // the cache changed), but peers keep serving the previous generation until
  // their TTL expires unless the write is broadcast. Both write paths in
  // app.js — the async cataloging after a payment and the manual
  // POST /discovery/resources — have to broadcast.
  const { createApp } = await import('../src/app.js');
  const { resolveConfig } = await import('../src/config.js');

  const PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const NETWORK = 'stellar:testnet';

  // The real resolver, so the app sees every field it reads (cors, apiKeys, the
  // rest) rather than a hand-rolled config that 500s on the first missing key.
  const config = resolveConfig({
    ...process.env,
    OPEN_MODE: 'true',
    FACILITATOR_SECRET: 'SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW',
  });

  function stubs() {
    const invalidated = [];
    const catalog = {
      version: 1,
      getVersion: () => catalog.version,
      async search() {
        return { resources: [], pagination: {} };
      },
      async listResources() {
        return { resources: [], items: [], total: 0 };
      },
      async getResource() {
        return null;
      },
      async upsertResource() {
        catalog.version += 1;
        return { url: 'https://a.example' };
      },
      // Present on the decorator; absent on a plain store, which is why every
      // call site uses `?.`.
      searchCache: { invalidate: async opts => invalidated.push(opts?.reason) },
    };
    const facilitator = {
      async verify() {
        return { isValid: true };
      },
      async settle() {
        return { success: true, transaction: 'tx_deadbeef', network: NETWORK };
      },
      getSupported() {
        return { schemes: {} };
      },
    };
    const rateLimiter = {
      async checkVerify() {
        return { allowed: true };
      },
      async checkSettle() {
        return { allowed: true };
      },
      async checkCatalog() {
        return { allowed: true };
      },
      async checkCatalogRead() {
        return { allowed: true };
      },
      async recordVerify() {},
      async recordSettle() {},
      async recordCatalog() {},
      async getUsage() {
        return {};
      },
    };
    return { invalidated, catalog, facilitator, rateLimiter };
  }

  const requirements = {
    scheme: 'exact',
    network: NETWORK,
    maxAmountRequired: '1000',
    resource: 'https://a.example',
    description: 'a resource',
    mimeType: 'application/json',
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
    asset: 'native',
    extra: { name: 'native' },
  };

  // A bazaar extension, because validateForCatalog hard-drops a declaration
  // without one — the payload shape is the repo's own fixture, so this test
  // cannot drift from what the handler actually accepts.
  const discoveryPayload = {
    x402Version: 2,
    resource: { url: 'https://a.example' },
    extensions: {
      bazaar: {
        info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
        schema: { type: 'object' },
        routeTemplate: '/a',
      },
    },
  };

  await t.test('the manual catalog write broadcasts', async () => {
    const s = stubs();
    const app = await createApp(config, s.facilitator, s.rateLimiter, s.catalog, null, {});
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/discovery/resources',
        payload: {
          paymentPayload: discoveryPayload,
          paymentRequirements: requirements,
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(s.invalidated, ['cataloging:manual']);
    } finally {
      await app.close();
    }
  });

  await t.test('the write that follows a payment broadcasts', async () => {
    const s = stubs();
    const app = await createApp(config, s.facilitator, s.rateLimiter, s.catalog, null, {});
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/settle',
        payload: {
          x402Version: 1,
          paymentPayload: {
            ...discoveryPayload,
            accepted: requirements,
            payer: PAYEE,
            payload: { signature: 'x', authorization: { signature: 'x' } },
          },
          paymentRequirements: requirements,
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      // Cataloging is deliberately off the hot path, so give the microtask
      // queue a turn before asserting the broadcast happened. The reason is
      // the route that triggered the write, which is what makes it possible to
      // tell the two write paths apart in a log.
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(s.invalidated, ['cataloging:settle']);
    } finally {
      await app.close();
    }
  });
});
