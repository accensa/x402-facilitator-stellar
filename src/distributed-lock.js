/**
 * Cross-process serialization for critical state transitions (#116).
 *
 * The event loop serializes requests within one process, but it does nothing
 * for interleaved async operations across pod replicas: two replicas can both
 * pass the idempotency check and both submit the same settlement to the chain.
 * The Redlock algorithm fixes that — a caller holds the lock only when a
 * quorum of independent Redis nodes agrees, so no single node's failure can
 * produce two holders.
 *
 * DEPLOYMENT SHAPE. Redlock wants an odd number (>= 3) of independent Redis
 * masters on separate failure domains; quorum is majority. REDLOCK_NODES is a
 * comma-separated list of those masters. With fewer than 3 nodes the lock
 * degrades to "majority of what exists" — still correct within that cluster,
 * but weaker failure isolation than the algorithm intends, and the boot log
 * says so. With no Redis at all the module falls back to an in-process mutex,
 * which keeps single-instance deployments correct and multi-instance ones no
 * worse than before this module existed.
 *
 * THE THREE GUARANTEES THIS MODULE IS RESPONSIBLE FOR:
 *
 *   1. Serialization — withLock() acquires before running, retrying until the
 *      acquire timeout; concurrent identical work waits instead of racing.
 *   2. Deadlock freedom — every lock carries a TTL and expires on its own, so
 *      a crashed holder cannot wedge a payment forever.
 *   3. Long-running safety — while the wrapped operation runs, the lock is
 *      re-extended (Fischer-Christian style) in the background, so an operation
 *      slower than the TTL does not lose exclusivity mid-flight. If extension
 *      fails, the operation is cancelled rather than allowed to continue
 *      unprotected.
 *
 * Fallback logic: if the Redlock quorum itself fails (all nodes down), the
 * module degrades to the in-process mutex and logs loudly — availability of
 * the endpoint is preserved, cross-process correctness is not silently
 * pretended.
 */

import { setInterval, clearInterval } from 'node:timers';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

/**
 * Raised when a lock could not be acquired within the configured timeout. The
 * transport maps this onto its own reason code rather than a bare 500 — see
 * src/app.js.
 */
export class LockAcquireTimeoutError extends Error {
  constructor(key, timeoutMs) {
    super(`could not acquire lock "${key}" within ${timeoutMs}ms`);
    this.name = 'LockAcquireTimeoutError';
    this.key = key;
  }
}

/**
 * Raised when a held lock could not be extended, so mutual exclusion was lost
 * while the wrapped operation was still running. The operation is abandoned
 * (even if it ignores the abort signal) rather than reported as successful
 * without the lock it was promised.
 */
export class LockLostError extends Error {
  constructor(key, cause) {
    super(`lost distributed lock "${key}": mutual exclusion was lost while the operation ran`);
    this.name = 'LockLostError';
    this.key = key;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * In-process mutex. The fallback path and the single-instance path are the
 * same code: each waiter chains behind the previous holder's release.
 *
 * The tail map holds, per key, a promise that resolves to the NEXT holder's
 * release function once the current holder is done. Chaining happens
 * synchronously at acquire time so two concurrent callers cannot both win.
 *
 * The map entry is dropped once its promise resolves and no newer waiter has
 * taken the key: settlement locks key on a per-payment idempotency key, so
 * retaining a resolved promise per key would grow with settlement volume.
 *
 * @param {object} [options]
 * @param {number} [options.acquireTimeoutMs] - how long acquire(key) waits
 *   for the key to be handed over before rejecting with LockAcquireTimeoutError;
 *   the memory fallback has no lock expiry of its own, so without a deadline a
 *   holder that never releases wedges every later waiter on that key
 */
export function createMemoryLockManager({ acquireTimeoutMs = 15_000 } = {}) {
  const tails = new Map();

  return {
    kind: 'memory',

    /**
     * Number of keys with a live or queued holder. Exposed for diagnostics and
     * so tests can assert the tail map drains; not part of the lock protocol.
     */
    get pendingKeys() {
      return tails.size;
    },

    /**
     * @returns {Promise<{release: Function}>} resolves once the key is held,
     *   or rejects with LockAcquireTimeoutError when the wait exceeds
     *   acquireTimeoutMs
     */
    acquire(key) {
      const prev = tails.get(key) ?? Promise.resolve(null);
      let release;
      const done = new Promise(resolve => {
        release = resolve;
      });
      // Clean up the entry when this holder releases. If another waiter chained
      // on before release, tails now holds that newer promise and must stay:
      // only delete our own entry.
      done.then(() => {
        if (tails.get(key) === done) tails.delete(key);
      });
      tails.set(key, done);

      return new Promise((resolve, reject) => {
        let delivered = false;
        let timedOut = false;
        const timer = setTimeout(() => {
          if (delivered) return;
          timedOut = true;
          // The caller is rejected now. The chain still has to move: waiters
          // queued behind this one chain on `done`, and it would stay pending
          // forever if the release resolver were dropped with the timed-out
          // waiter — so advance it once the previous holder releases.
          prev
            .then(() => {
              if (delivered) return;
              delivered = true;
              release();
            })
            .catch(() => {});
          reject(new LockAcquireTimeoutError(key, acquireTimeoutMs));
        }, acquireTimeoutMs);

        prev
          .then(() => {
            if (delivered || timedOut) return;
            delivered = true;
            clearTimeout(timer);
            resolve({ release });
          })
          .catch(() => {});
      });
    },

    async withLock(key, fn) {
      const handle = await this.acquire(key);
      try {
        return await fn();
      } finally {
        handle.release();
      }
    },

    async quit() {},
  };
}

/**
 * Builds ioredis clients from a list of Redis URLs without importing ioredis
 * until there is something to connect to.
 */
function defaultClientFactory(urls) {
  const Redis = require('ioredis');
  return urls.map(
    url =>
      new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        retryStrategy(times) {
          // Reconnect forever but back off hard; a downed node should not be
          // hammered, and redlock tolerates minority outages anyway.
          return Math.min(times * 1000, 10_000);
        },
        enableOfflineQueue: false,
      }),
  );
}

/**
 * Creates the distributed lock manager.
 *
 * @param {object} [options]
 * @param {string[]} [options.nodes] - Redis master URLs (>=3 recommended)
 * @param {number} [options.ttlMs] - lock time-to-live; locks expire on their
 *   own after this long even if the holder dies
 * @param {number} [options.acquireTimeoutMs] - how long withLock() waits for
 *   a contended lock before giving up with LockAcquireTimeoutError
 * @param {number} [options.retryDelayMs] - delay between acquire attempts
 * @param {Function} [options.createClient] - client factory (injectable for tests);
 *   receives the node URL list, returns redis-like clients
 * @param {(msg: string) => void} [options.warn] - degradation warnings
 * @param {(msg: string) => void} [options.log]
 */
export function createDistributedLock({
  nodes = [],
  ttlMs = 30_000,
  acquireTimeoutMs = 15_000,
  retryDelayMs = 200,
  createClient = defaultClientFactory,
  warn = msg => console.warn(msg),
  log = () => {},
} = {}) {
  const urls = nodes.filter(Boolean);

  if (urls.length === 0) {
    log('distributed-lock: no Redis nodes configured — using in-process locking only');
    return createMemoryLockManager({ acquireTimeoutMs });
  }

  if (urls.length < 3) {
    warn(
      `distributed-lock: ${urls.length} Redis node(s) configured; ` +
        'Redlock is designed for >= 3 independent masters — fault tolerance is reduced',
    );
  }

  const clients = createClient(urls);
  // redlock v5 ships ESM; require() lands its default under .default.
  const mod = require('redlock');
  const Redlock = mod.default ?? mod;
  const redlock = new Redlock(clients, {
    driftFactor: 0.01,
    retryCount: Math.max(1, Math.ceil(acquireTimeoutMs / retryDelayMs)),
    retryDelay: retryDelayMs,
    retryJitter: Math.min(200, retryDelayMs),
  });

  redlock.on('clientError', err => warn(`distributed-lock: redis client error: ${err.message}`));

  const memoryFallback = createMemoryLockManager({ acquireTimeoutMs });
  let degraded = false;

  /**
   * Runs fn() while holding the named lock.
   *
   * Re-extends the lock in the background at ttl/3 so operations longer than
   * the TTL stay exclusive. If an extension fails, mutual exclusion is gone:
   * the operation is aborted via the cancel signal and, even if fn ignores
   * that signal, withRedlock rejects with LockLostError instead of letting an
   * unprotected result pass as successful.
   *
   * @param {string} key
   * @param {(signal: AbortSignal) => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  async function withRedlock(key, fn) {
    let lock;
    const deadline = Date.now() + acquireTimeoutMs;
    for (;;) {
      try {
        lock = await redlock.acquire([key], ttlMs);
        break;
      } catch {
        if (Date.now() >= deadline) {
          throw new LockAcquireTimeoutError(key, acquireTimeoutMs);
        }
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }

    const controller = new AbortController();

    // Rejects as soon as the extension path aborts the controller, so it can
    // win the race below even when fn never observes the signal.
    let rejectAbort;
    const abortPromise = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      const reason = controller.signal.reason;
      rejectAbort(reason instanceof LockLostError ? reason : new LockLostError(key, reason));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });

    const timer = setInterval(
      () => {
        lock.extend(ttlMs).catch(cause => {
          warn(`distributed-lock: lost lock "${key}" during extension`);
          controller.abort(new LockLostError(key, cause));
        });
      },
      Math.max(1000, Math.floor(ttlMs / 3)),
    );
    // Never hold the process open for the sake of an extension tick.
    timer.unref?.();

    const fnPromise = Promise.resolve().then(() => fn(controller.signal));
    // If the abort path wins, fn may still reject later. Mark that rejection as
    // handled so Node does not emit an UnhandledPromiseRejection.
    fnPromise.catch(() => {});

    try {
      return await Promise.race([fnPromise, abortPromise]);
    } finally {
      clearInterval(timer);
      controller.signal.removeEventListener('abort', onAbort);
      try {
        await lock.release();
      } catch (err) {
        // Release failure usually means the lock already expired. The TTL is
        // the deadlock backstop; nothing more to do here.
        log(`distributed-lock: release of "${key}" failed: ${err.message}`);
      }
    }
  }

  return {
    kind: 'redlock',

    /**
     * Serializes fn() against other holders of key across all replicas.
     *
     * @param {string} key
     * @param {(signal?: AbortSignal) => Promise<T>} fn
     * @param {{ttlMs?: number}} [_opts]
     * @returns {Promise<T>}
     * @template T
     */
    async withLock(key, fn, _opts = {}) {
      if (degraded) return memoryFallback.withLock(key, fn);

      try {
        return await withRedlock(key, fn);
      } catch (err) {
        // Two very different failures reach this handler:
        //
        //   - The lock was held elsewhere and never freed inside the acquire
        //     window while Redis itself was healthy: refuse. Running the
        //     mutation unprotected here would be exactly the race this module
        //     exists to prevent.
        //
        //   - Every Redis node is unreachable: degrade to the in-process
        //     mutex rather than wedge the endpoint entirely. This trades
        //     cross-replica strictness for availability, and it is loud, not
        //     silent — the warn below is the operator's cue that their Redis
        //     fleet is down.
        if (!(err instanceof LockAcquireTimeoutError)) throw err;
        const anyNodeReachable = clients.some(c => c.status === 'ready');
        if (anyNodeReachable) throw err;

        degraded = true;
        warn(
          'distributed-lock: no Redis node reachable (' +
            err.message +
            ') — degrading to in-process locking; cross-replica serialization is NOT guaranteed',
        );
        return memoryFallback.withLock(key, fn);
      }
    },

    /** Closes Redis connections; called on shutdown. */
    async quit() {
      await memoryFallback.quit().catch(() => {});
      await Promise.allSettled([...clients.map(c => c.quit()), redlock.quit?.()].filter(Boolean));
    },
  };
}

/**
 * Recursively normalizes a value so JSON.stringify emits object keys in a
 * deterministic order. Arrays keep their element order; objects inside them
 * are still canonicalized. `undefined` object properties are omitted exactly
 * as JSON.stringify would omit them.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map(canonicalize);

  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) continue;
    normalized[key] = canonicalize(entry);
  }
  return normalized;
}

/**
 * JSON.stringify with deterministic object key ordering. Property insertion
 * order is not part of a JSON object's meaning, so replicas must not let it
 * change a derived lock key.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Derives a stable lock key from an arbitrary payment-shaped object. Two
 * replicas must agree on this key byte-for-byte for serialization to engage,
 * so it hashes canonical JSON rather than trusting any client-supplied string.
 *
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {string}
 */
export function lockKeyFor(value, prefix = 'settle') {
  const digest = crypto
    .createHash('sha256')
    .update(canonicalStringify(value ?? null))
    .digest('hex');
  return `${prefix}:${digest}`;
}
