/**
 * Two-tier cache for catalog discovery queries (#392).
 *
 * Discovery is the read-mostly hot path of the facilitator: agents poll
 * `/discovery/search` continuously, the same handful of queries dominate, and
 * every miss costs a full Postgres scan with a lexical + dense ranking pass on
 * top. The two tiers exist because those two facts pull in opposite directions:
 *
 *   - **L1 (in-process LRU, ~5s TTL)** absorbs the repeat traffic from this
 *     node. A Map lookup is ~100ns; a Redis round trip is ~0.5ms. Keeping the
 *     hottest entries local is what removes Redis from the request path
 *     entirely for the common case.
 *   - **L2 (Redis, 60s TTL)** absorbs the traffic that *misses* L1 because it
 *     landed on a different replica, or because the entry aged out of L1. It
 *     is the reason N replicas issue one database query per distinct query
 *     rather than N.
 *
 * Correctness comes from the store's monotonic write version, not from the
 * TTLs. `CatalogStore.getVersion()` increments on every write, and it is part
 * of the key, so a write makes every previously cached entry unreachable
 * immediately — no read can be served from a stale generation. TTLs are then
 * only a memory-bounding device, which is why the L1 window can be short
 * without risking a stale read.
 *
 * Cross-replica propagation uses Redis Pub/Sub on the invalidation channel: a
 * writer publishes, and every node drops its L1. Pub/Sub is fire-and-forget
 * and lossy by design, so it is an *optimisation* — a node that misses the
 * message still cannot serve stale data, because the version it read from the
 * store has already moved on. The TTL is the backstop, not the correctness
 * argument.
 *
 * Degradation follows the rate limiter's rule (#94): Redis is optional. If it
 * is absent, unreachable, or throws mid-flight, lookups fall through to the
 * store and the cache simply stops helping. A cache outage must never become a
 * discovery outage.
 */
import { searchCacheKey } from './search.js';
import { createRedisConnection } from '../redis-client.js';

/** L1 window. Short by design: the version in the key is what guarantees freshness. */
export const DEFAULT_L1_TTL_MS = 5_000;
/** L2 window — long enough to absorb a replica's cold start, short enough to bound staleness of a missed invalidation. */
export const DEFAULT_L2_TTL_SEC = 60;
/** L1 capacity. Sized for a busy facilitator's distinct-query working set, not the whole catalog. */
export const DEFAULT_L1_MAX_ENTRIES = 500;
export const DEFAULT_INVALIDATION_CHANNEL = 'x402:catalog:invalidate';
const KEY_PREFIX = 'x402:catalog:search';

/**
 * Fixed-capacity map with per-entry TTL and least-recently-*used* eviction.
 *
 * A Map already preserves insertion order, which is what makes this an LRU in
 * seven lines: on a hit, delete and re-insert the key so it moves to the tail;
 * when the map is over capacity, the head is the coldest entry. This is a
 * dedicated Map rather than reusing `src/rate-limit.js`'s sliding windows
 * because the eviction policy is the entire point here.
 */
export class LruTtlCache {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries=500]
   * @param {number} [options.ttlMs=5000]
   * @param {() => number} [options.now=Date.now] - injectable clock for tests
   */
  constructor({
    maxEntries = DEFAULT_L1_MAX_ENTRIES,
    ttlMs = DEFAULT_L1_TTL_MS,
    now = Date.now,
  } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, {value: unknown, expiresAt: number}>} */
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  /**
   * @param {string} key
   * @returns {unknown|undefined} undefined for a miss, an expired entry, or a
   *   stored `undefined` — the cache never stores undefined.
   */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to mark as most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      // The first key in Map iteration order is the coldest.
      const coldest = this.entries.keys().next().value;
      this.entries.delete(coldest);
    }
  }

  delete(key) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * Read-through cache in front of a `CatalogStore`, with a version-scoped L1
 * and a shared L2.
 *
 * Concurrent misses for the same key collapse into one store call. Without
 * that, the L1's 5-second window is also a 5-second stampede window: every
 * replica's L1 expires together, every agent request in flight re-queries, and
 * the database sees a spike that the cache was supposed to remove.
 *
 * Cache lookup metrics (#392): `onLookup` receives tier/outcome events for
 * each cache operation, enabling OpenTelemetry counters for hit/miss/error
 * ratios per tier. When an `incCatalogCacheLookup` function is passed as
 * `onLookup`, lookups are reported to the Prometheus metrics pipeline.
 * The `withSearchCache` wrapper passes this through automatically.
 */
export class CatalogSearchCache {
  /**
   * @param {object} options
   * @param {object} options.store - a `CatalogStore` (or anything with `search`)
   * @param {object} [options.redis] - ioredis-compatible client, injected in tests
   * @param {string|null} [options.redisUrl]
   * @param {string} [options.channel] - pub/sub invalidation channel
   * @param {number} [options.l1TtlMs]
   * @param {number} [options.l2TtlSec]
   * @param {number} [options.maxEntries]
   * @param {(event: {tier: 'l1'|'l2', outcome: 'hit'|'miss'|'error'}) => void} [options.onLookup]
   *   metrics sink; see `incCatalogCacheLookup` in src/metrics.js
   * @param {(msg: string) => void} [options.warn]
   * @param {() => number} [options.now]
   */
  constructor({
    store,
    redis,
    redisUrl = null,
    channel = DEFAULT_INVALIDATION_CHANNEL,
    l1TtlMs = DEFAULT_L1_TTL_MS,
    l2TtlSec = DEFAULT_L2_TTL_SEC,
    maxEntries = DEFAULT_L1_MAX_ENTRIES,
    onLookup = null,
    warn = msg => console.warn(msg),
    now = Date.now,
  }) {
    this.store = store;
    this.channel = channel;
    this.l2TtlSec = l2TtlSec;
    this.warn = warn;
    this.now = now;
    this.l1 = new LruTtlCache({ maxEntries, ttlMs: l1TtlMs, now });
    this.onLookup = onLookup;

    /** In-flight store calls, keyed by cache key — the single-flight table. */
    this.inflight = new Map();
    /**
     * Highest catalog version this node has observed. A Pub/Sub invalidation
     * that carries a *newer* version raises this floor, so a slow local store
     * read cannot re-populate L1 with a generation that is already retired.
     */
    this.minValidVersion = 0;
    this.lastSeenVersion = 0;

    this.connection = createRedisConnection({
      client: redis,
      redisUrl,
      onEvent: event => {
        if (event.type === 'unavailable') {
          this.warn(`[CatalogCache] ${event.message}; searching the store directly`);
        } else if (event.type === 'degraded') {
          this.warn(`[CatalogCache] ${event.message}; searching the store directly`);
        } else {
          this.warn('[CatalogCache] Redis reconnected — shared cache entries available again');
        }
      },
    });
    this.redis = this.connection.client;
    this.connection.ready.then(client => {
      this.redis = client;
    });

    /** The pub/sub subscriber; a separate connection, as Redis requires. */
    this.subscriber = null;
    /** True only when this cache created the subscriber and must close it. */
    this.subscriberOwned = false;
    this.subscriberReady = null;

    /**
     * Per-tier lookup tallies. Held here as well as in the metrics sink so
     * `stats()` is meaningful with no registry attached (tests, and any
     * embedding that does not expose `/metrics`).
     */
    this.counters = {
      l1: { hit: 0, miss: 0, error: 0 },
      l2: { hit: 0, miss: 0, error: 0 },
    };
  }

  /** The store's current write version, or 0 for a store that has none. */
  _currentVersion() {
    try {
      return this.store?.getVersion?.() ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Cache key for a search, scoped to the catalog version.
   *
   * The version is part of the key rather than a stored field, so a stale entry
   * is not merely preferred against — it is unreachable, and no amount of clock
   * skew or a dropped invalidation message can resurrect it.
   */
  keyFor(params, version = this._currentVersion()) {
    return `${KEY_PREFIX}:v${version}:${searchCacheKey(params)}`;
  }

  _record(tier, outcome) {
    this.counters[tier][outcome] += 1;
    try {
      this.onLookup?.({ tier, outcome });
    } catch {
      // A metrics sink must never be able to fail a discovery request.
    }
  }

  /** L2 read, with every failure collapsing to a miss. */
  async _readL2(key) {
    if (!this.connection.isUsable()) return null;
    try {
      const raw = await this.redis.get(key);
      if (raw == null) {
        this._record('l2', 'miss');
        return null;
      }
      this._record('l2', 'hit');
      return JSON.parse(raw);
    } catch (err) {
      this._record('l2', 'error');
      this.connection.onDegrade(`L2 read failed: ${err.message}`);
      return null;
    }
  }

  /** L2 write. Best-effort: a failure costs performance, never correctness. */
  async _writeL2(key, value) {
    if (!this.connection.isUsable()) return;
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', this.l2TtlSec);
    } catch (err) {
      this.connection.onDegrade(`L2 write failed: ${err.message}`);
    }
  }

  /**
   * The cached read-through path.
   *
   * @param {object} params - `CatalogStore.search()` params
   * @returns {Promise<object>} the search result, exactly as the store shaped it
   */
  async search(params) {
    const version = this._currentVersion();

    // A write this node made itself, or one a peer announced, retires the whole
    // L1. Cheaper and more obviously correct than leaving the old generation to
    // age out, and it keeps the map from holding two generations at once.
    if (version !== this.lastSeenVersion) {
      this.lastSeenVersion = version;
      if (version > this.minValidVersion) this.minValidVersion = version;
      if (this.l1.size > 0) this.l1.clear();
    }

    const key = this.keyFor(params, version);

    const l1 = this.l1.get(key);
    if (l1 !== undefined) {
      this._record('l1', 'hit');
      return l1;
    }
    this._record('l1', 'miss');

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const call = this._load(key, params, version).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, call);
    return call;
  }

  async _load(key, params, version) {
    // Everything below is conditional on the generation still being live. A
    // generation retired by a peer's broadcast is not merely uncacheable — it
    // must not be *served*, and there is no point paying a Redis round trip to
    // fetch a key we already know is stale.
    const live = version >= this.minValidVersion;

    if (live) {
      const shared = await this._readL2(key);
      if (shared !== null) {
        this.l1.set(key, shared);
        return shared;
      }
    }

    const result = await this.store.search(params);

    if (live) {
      this.l1.set(key, result);
      await this._writeL2(key, result);
    }
    return result;
  }

  /**
   * Invalidates cached searches and tells every other replica to do the same.
   *
   * The local store's version bump is what actually makes old entries
   * unreachable; the publish is how peers find out *now* rather than on their
   * next L1 miss.
   *
   * @param {object} [options]
   * @param {string} [options.reason] - free text for the log line
   * @param {number} [options.version] - the new version, read from the store when omitted
   * @returns {Promise<void>}
   */
  async invalidate({ reason = 'catalog write', version = this._currentVersion() } = {}) {
    if (version > this.minValidVersion) this.minValidVersion = version;
    this.lastSeenVersion = version;
    this.l1.clear();

    if (!this.connection.isUsable()) return;
    try {
      await this.redis.publish(
        this.channel,
        JSON.stringify({ version, reason, at: new Date().toISOString() }),
      );
    } catch (err) {
      // Losing the broadcast costs at most l1TtlMs of staleness on other nodes:
      // their version check still refuses the retired generation.
      this.warn(`[CatalogCache] could not publish invalidation: ${err.message}`);
    }
  }

  /**
   * Subscribes to the invalidation channel. Safe to call once; idempotent.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.subscriber || !this.connection.isUsable()) return;
    try {
      // A subscribed connection cannot serve normal commands, so Pub/Sub gets
      // its own — `duplicate()` on ioredis, or the caller's factory in tests.
      this.subscriberOwned = Boolean(this.redis.duplicate);
      this.subscriber = this.subscriberOwned ? this.redis.duplicate() : this.redis;
      this.subscriber.on('error', err =>
        this.warn(`[CatalogCache] subscriber error: ${err.message}`),
      );
      await this.subscriber.subscribe(this.channel);
      this.subscriber.on('message', (channel, message) => this._onMessage(channel, message));
      this.subscriberReady = true;
    } catch (err) {
      this.warn(`[CatalogCache] invalidation subscribe failed: ${err.message}`);
      this.subscriber = null;
      this.subscriberOwned = false;
    }
  }

  _onMessage(channel, message) {
    if (channel !== this.channel) return;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      // A foreign publisher on the channel; ignore rather than drop the cache.
      return;
    }
    const version = Number(payload?.version);
    if (!Number.isFinite(version)) return;
    if (version <= this.minValidVersion) return;
    this.minValidVersion = version;
    this.l1.clear();
  }

  /**
   * Unsubscribes and releases the subscriber connection.
   * @returns {Promise<void>}
   */
  async stop() {
    const subscriber = this.subscriber;
    const owned = this.subscriberOwned;
    this.subscriber = null;
    this.subscriberOwned = false;
    this.subscriberReady = null;
    this.l1.clear();
    if (!subscriber) return;
    try {
      await subscriber.unsubscribe?.(this.channel);
    } catch {
      // Shutdown is best-effort.
    }
    try {
      // Only a connection this cache created is ours to close. When
      // `duplicate()` is unavailable the subscriber *is* the caller's client.
      if (owned) await subscriber.quit?.();
    } catch {
      // Already gone.
    }
  }

  /**
   * Counters for `GET /metrics` and for tests.
   *
   * The hit ratio is reported per tier rather than as one blended number: a
   * healthy L1 over a cold L2 is a different problem from a cold L1, and a
   * blend hides the difference. `error` is counted separately from `miss`
   * because a Redis that is timing out looks identical to an empty cache if
   * failures are folded into misses — and the two need opposite responses.
   *
   * @returns {{l1: object, l2: object, inflight: number, minValidVersion: number}}
   */
  stats() {
    const withRatio = tier => {
      const { hit, miss, error } = this.counters[tier];
      const decided = hit + miss;
      return {
        hit,
        miss,
        error,
        // Null, not 0, before anything is decided: an undefined-looking ratio
        // on a cold cache should not be scraped as a 0% hit rate.
        ratio: decided === 0 ? null : Number((hit / decided).toFixed(4)),
        ...(tier === 'l1' ? { size: this.l1.size, maxEntries: this.l1.maxEntries } : {}),
        ...(tier === 'l2' ? { enabled: this.connection.isUsable() } : {}),
      };
    };
    return {
      l1: withRatio('l1'),
      l2: withRatio('l2'),
      inflight: this.inflight.size,
      minValidVersion: this.minValidVersion,
    };
  }
}

/**
 * Wraps a catalog store so `search()` is served through {@link CatalogSearchCache}
 * and every other method passes straight through.
 *
 * A Proxy rather than a hand-written subclass because `CatalogStore` has nine
 * methods and grows over time — a decorator that enumerates them would silently
 * drop any added later, and a missing method on a discovery path is a 500.
 *
 * @param {object} store - a `CatalogStore`
 * @param {object} [options] - forwarded to {@link CatalogSearchCache}, minus `store`
 * @returns {object} a store with the same surface, cached `search`
 */
export function withSearchCache(store, options = {}) {
  const cache = new CatalogSearchCache({ ...options, store });
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'searchCache') return cache;
      if (prop in cache) {
        const value = cache[prop];
        return typeof value === 'function' ? value.bind(cache) : value;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export default withSearchCache;
