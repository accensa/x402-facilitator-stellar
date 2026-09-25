/**
 * Persistent, pooled, circuit-broken HTTP for Stellar backends (#120).
 *
 * THE PROBLEM. Every RPC/Horizon call that opens a fresh TCP connection pays
 * a full handshake, and under burst load the socket table fills with
 * TIME_WAIT corpses before connections can be recycled. The fix is keep-alive
 * pooling: a bounded set of long-lived connections shared across requests.
 *
 * THE SECOND PROBLEM. When a backend node degrades (timeouts, resets), naive
 * retrying turns one slow dependency into an outage of our own: every in-flight
 * request queues behind a backend that cannot answer. The circuit breaker
 * (opossum) trips after consecutive failures, fails fast while open, and lets
 * single probes through once half-open — closing again when the backend
 * recovers.
 *
 * MECHANISM. The Stellar SDK reaches its endpoints through the global fetch,
 * so this module replaces globalThis.fetch with a composed pipeline:
 *
 *   caller → circuit breaker (per origin) → undici Agent (keep-alive pool)
 *
 * It is designed to be installed BEFORE installRpcRetry() in server.js, so the
 * retry wrapper sits outside the breaker: connection-level retries still
 * happen, but repeated failure feeds the breaker's statistics rather than
 * hammering a dead node forever.
 *
 * Per-origin breakers: testnet RPC going down must not block pubnet traffic,
 * so each origin gets its own breaker.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function originOf(input) {
  try {
    const url = typeof input === 'string' ? input : input?.url;
    return url ? new URL(url).origin : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Installs the pooled, breaker-wrapped fetch over globalThis.fetch.
 *
 * @param {object} [options]
 * @param {Function} [options.baseFetch] - underlying fetch (injectable for tests)
 * @param {number} [options.maxSockets] - max keep-alive connections per origin
 * @param {number} [options.keepAliveTimeoutMs] - idle socket lifetime
 * @param {number} [options.keepAliveMaxTimeoutMs] - hard socket lifetime cap
 * @param {number} [options.headersTimeoutMs] - response-header deadline per request
 * @param {number} [options.breakerTimeoutMs] - request timeout feeding the breaker
 * @param {number} [options.breakerErrorThreshold] - % failures that trip the breaker
 * @param {number} [options.breakerResetTimeoutMs] - open → half-open delay
 * @param {(msg: string) => void} [options.log]
 * @param {(msg: string) => void} [options.warn]
 * @returns {{ breakers: Map<string, object>, stats: Function, restore: Function }}
 */
export function installHorizonClient({
  baseFetch = globalThis.fetch,
  maxSockets = Number(process.env.HORIZON_MAX_SOCKETS ?? 64),
  keepAliveTimeoutMs = Number(process.env.HORIZON_KEEP_ALIVE_TIMEOUT_MS ?? 4000),
  keepAliveMaxTimeoutMs = Number(process.env.HORIZON_KEEP_ALIVE_MAX_TIMEOUT_MS ?? 10_000),
  headersTimeoutMs = Number(process.env.HORIZON_HEADERS_TIMEOUT_MS ?? 30_000),
  breakerTimeoutMs = Number(process.env.BREAKER_TIMEOUT_MS ?? 15_000),
  breakerErrorThreshold = Number(process.env.BREAKER_ERROR_THRESHOLD_PERCENTAGE ?? 50),
  breakerResetTimeoutMs = Number(process.env.BREAKER_RESET_TIMEOUT_MS ?? 30_000),
  rpcForceIpv4 = true,
  log = () => {},
  warn = msg => console.warn(msg),
} = {}) {
  const originalFetch = baseFetch;
  const previousGlobalFetch = globalThis.fetch;
  let restored = false;

  // undici's Agent is what actually owns the sockets: keepAliveTimeout recycles
  // idle connections promptly (freeing server-side slots) while the cap bounds
  // how many we hold open per origin at all.
  const { Agent } = require('undici');
  const agent = new Agent({
    connections: maxSockets,
    pipelining: 1,
    keepAliveTimeout: keepAliveTimeoutMs,
    keepAliveMaxTimeout: keepAliveMaxTimeoutMs,
    headersTimeout: headersTimeoutMs,
    connect: { family: rpcForceIpv4 ? 4 : undefined },
  });

  const Opossum = require('opossum');

  /** One breaker per origin; testnet trouble never blocks pubnet. */
  const breakers = new Map();

  function breakerFor(origin) {
    let breaker = breakers.get(origin);
    if (breaker) return breaker;

    breaker = new Opossum(input => originalFetch(input, { dispatcher: agent }), {
      timeout: breakerTimeoutMs,
      errorThresholdPercentage: breakerErrorThreshold,
      resetTimeout: breakerResetTimeoutMs,
      allowWarmUp: false,
      volumeThreshold: 3,
    });

    breaker.on('open', () =>
      warn(
        `circuit breaker OPEN for ${origin} — failing fast until ${new Date(Date.now() + breakerResetTimeoutMs).toISOString()}`,
      ),
    );
    breaker.on('halfOpen', () => log(`circuit breaker HALF-OPEN for ${origin} — probing`));
    breaker.on('close', () => log(`circuit breaker CLOSED for ${origin} — recovered`));

    breakers.set(origin, breaker);
    return breaker;
  }

  /**
   * The composed fetch. Breaker state transitions are logged so an operator
   * can see trip/recover events without attaching a debugger.
   */
  async function pooledBreakerFetch(input, init) {
    const breaker = breakerFor(originOf(input));
    return breaker.fire(
      init === undefined ? input : async () => originalFetch(input, { ...init, dispatcher: agent }),
    );
  }

  pooledBreakerFetch.preconnect = _origin => agent;
  globalThis.fetch = pooledBreakerFetch;

  return {
    breakers,

    /** Snapshot of breaker states per origin, for /healthz or logging. */
    stats() {
      return Object.fromEntries(
        [...breakers.entries()].map(([origin, b]) => [
          origin,
          {
            state: b.opened ? 'open' : 'closed',
            failures: b.stats.failures,
            successes: b.stats.successes,
          },
        ]),
      );
    },

    /** Restores whatever fetch was global before installation. */
    restore() {
      if (restored) return;
      restored = true;
      globalThis.fetch = previousGlobalFetch;
      agent.close().catch(() => {});
      breakers.forEach(b => b.shutdown());
      breakers.clear();
    },
  };
}
