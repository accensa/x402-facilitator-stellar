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

/** Horizon's fee_stats are per ledger; a ledger closes roughly every 5s. */
export const FEE_STATS_TTL_MS = 5000;
/** Stellar's protocol minimum base fee per operation, in stroops. */
export const MIN_BASE_FEE_STROOPS = 100;
/** Priority → fee_charged percentile the bid is anchored to. */
const PRIORITY_TIERS = ['low', 'normal', 'high'];
const TIER_PERCENTILE = { low: 'p50', normal: 'p90', high: 'p99' };
/** A deadline shorter than ~one ledger cannot wait out a surge: bid one tier up. */
const URGENT_DEADLINE_MS = 5000;

const toStroops = value => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
};

/**
 * Dynamic fee estimation from Horizon `/fee_stats`.
 *
 * `fetchFeeStats()` returns the p50/p90/p99 fee_charged rates (stroops per
 * operation), cached for 5s so a burst of settlements costs one Horizon call;
 * concurrent callers share the in-flight request. `estimateFee()` maps
 * priority and deadline to a percentile and clamps the bid to a hard ceiling,
 * so congestion can never push spend past `maxFeeStroops`.
 *
 * If Horizon is unreachable the last known stats are used (however stale);
 * with none at all the bid falls back to the protocol minimum and is flagged
 * `source: 'fallback'`. The ceiling applies in every case.
 *
 * @param {object} options
 * @param {string} options.horizonUrl - Horizon base URL
 * @param {number} options.maxFeeStroops - strict ceiling on any bid
 * @param {Function} [options.fetchFn] - injectable fetch (defaults to global, i.e. the pooled one)
 * @param {number} [options.ttlMs=5000]
 * @param {() => number} [options.now] - injectable clock
 */
export function createFeeEstimator({
  horizonUrl,
  maxFeeStroops,
  fetchFn = (...args) => globalThis.fetch(...args),
  ttlMs = FEE_STATS_TTL_MS,
  now = Date.now,
}) {
  if (!horizonUrl) throw new Error('createFeeEstimator: horizonUrl is required');
  if (!Number.isFinite(maxFeeStroops) || maxFeeStroops < MIN_BASE_FEE_STROOPS) {
    throw new Error(`createFeeEstimator: maxFeeStroops must be >= ${MIN_BASE_FEE_STROOPS}`);
  }
  const url = `${horizonUrl.replace(/\/+$/, '')}/fee_stats`;
  let cached = null; // { stats, at }
  let inflight = null;

  async function load() {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`fee_stats returned HTTP ${res.status}`);
    const body = await res.json();
    const charged = body.fee_charged ?? {};
    const baseFee = toStroops(body.last_ledger_base_fee) ?? MIN_BASE_FEE_STROOPS;
    const rates = {};
    for (const p of ['p50', 'p90', 'p99']) {
      const rate = toStroops(charged[p]);
      if (rate === null) throw new Error(`fee_stats response is missing fee_charged.${p}`);
      rates[p] = Math.max(rate, baseFee);
    }
    return {
      ...rates,
      baseFee,
      ledgerCapacityUsage: Number(body.ledger_capacity_usage) || 0,
    };
  }

  async function fetchFeeStats() {
    if (cached && now() - cached.at < ttlMs) return cached.stats;
    inflight ??= load()
      .then(stats => {
        cached = { stats, at: now() };
        return stats;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /**
   * @param {object} [request]
   * @param {'low'|'normal'|'high'} [request.priority='normal']
   * @param {number} [request.deadlineMs] - time the caller can wait for inclusion
   * @returns {Promise<{feeStroops: number, tier: string, capped: boolean, source: 'horizon'|'stale'|'fallback'}>}
   */
  async function estimateFee({ priority = 'normal', deadlineMs } = {}) {
    let tierIndex = PRIORITY_TIERS.indexOf(priority);
    if (tierIndex === -1) throw new Error(`Unknown fee priority: ${priority}`);
    if (deadlineMs !== undefined && !(Number.isFinite(deadlineMs) && deadlineMs > 0)) {
      throw new Error('deadlineMs must be a positive number');
    }
    if (deadlineMs !== undefined && deadlineMs < URGENT_DEADLINE_MS) {
      tierIndex = Math.min(tierIndex + 1, PRIORITY_TIERS.length - 1);
    }
    const tier = PRIORITY_TIERS[tierIndex];

    let stats;
    let source = 'horizon';
    try {
      stats = await fetchFeeStats();
    } catch {
      stats = cached?.stats;
      source = stats ? 'stale' : 'fallback';
    }
    const bid = stats ? stats[TIER_PERCENTILE[tier]] : MIN_BASE_FEE_STROOPS;
    const feeStroops = Math.min(bid, maxFeeStroops);
    return { feeStroops, tier, capped: bid > maxFeeStroops, source };
  }

  return { fetchFeeStats, estimateFee, maxFeeStroops };
}
