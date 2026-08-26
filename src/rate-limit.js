/**
 * Sliding-window (fixed-window) rate limiter and usage meter.
 *
 * Issue #94: bucket state lives behind a store interface (src/rate-limit-store.js)
 * instead of a per-process Map. With no configuration the store is in-memory
 * and behaviour is exactly what it was before; with RATE_LIMIT_STORE=postgres
 * the buckets are shared, so two replicas enforce one combined limit and the
 * daily fee ceiling survives a restart.
 *
 * DEGRADE DECISION — fail closed when a shared store is configured and
 * unreachable. A limiter that cannot read its counters has no idea whether the
 * daily fee ceiling has been spent; failing open there re-creates the exact bug
 * this issue fixes (unbounded sponsored spend), so checks refuse with the
 * distinct reason 'rate_limit_store_unavailable' until the store answers
 * again. The default memory store cannot be unreachable, so an unconfigured
 * instance never sees this path.
 *
 * Records (recordSettle etc.) are the one place that degrades open: they run
 * after the payment has already succeeded, and throwing would turn a settled
 * payment into a 5xx. A lost record is logged loudly instead — and because the
 * preceding check failed closed while the store was down, a sustained outage
 * does not accumulate uncounted spend.
 */
import { MemoryStore } from './rate-limit-store.js';

export class RateLimiter {
  /**
   * @param {object} config - { global: {...}, keys: {...} } limits
   * @param {{get: Function, increment: Function, sweep: Function}} [store]
   *   Defaults to in-process memory. Pass a shared store to enforce combined
   *   limits across replicas; two limiters pointed at one store behave as one.
   */
  constructor(config, store = new MemoryStore()) {
    this.config = config;
    this.store = store;
  }

  _getKeyConfig(keyId) {
    return this.config.keys[keyId] || this.config.global;
  }

  _getBucketId(ownerId, type, windowSec) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSec);
    return `${ownerId}:${type}:${windowStart}:${windowSec}`;
  }

  async _increment(ownerId, type, windowSec, amount = 1) {
    const now = Math.floor(Date.now() / 1000);
    const bucketId = this._getBucketId(ownerId, type, windowSec);
    const resetAt = now - (now % windowSec) + windowSec;

    try {
      const bucket = await this.store.increment(bucketId, amount, resetAt, now);
      // cleanup old buckets periodically
      if (Math.random() < 0.05) await this._sweep(now);
      return bucket;
    } catch (err) {
      console.error(`[RateLimit] store increment failed (${err.message}) — count not recorded`);
      return { count: NaN, resetAt };
    }
  }

  /**
   * Reads current usage without consuming anything. Any store failure fails
   * CLOSED: see the degrade decision at the top of this file.
   */
  async _check(ownerId, type, windowSec, limit, amount = 1) {
    const now = Math.floor(Date.now() / 1000);
    const bucketId = this._getBucketId(ownerId, type, windowSec);

    let bucket;
    try {
      bucket = await this.store.get(bucketId, now);
    } catch {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: now + windowSec,
        reason: 'rate_limit_store_unavailable',
      };
    }
    const resetAt = bucket?.resetAt ?? now - (now % windowSec) + windowSec;
    const count = bucket?.count ?? 0;
    if (count + amount > limit) {
      return { allowed: false, limit, remaining: 0, resetAt };
    }
    return { allowed: true, limit, remaining: limit - count - amount, resetAt };
  }

  async _sweep(now) {
    try {
      await this.store.sweep(now);
    } catch {
      // Sweep is pure housekeeping; the next request retries it. An empty
      // catch is normally banned here — this one is the deliberate exception:
      // sweeping must never be able to take down a request that already
      // passed its limit check.
    }
  }

  async checkVerify(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const res = await this._check(ownerId, 'verify', 60, limits.verifyRpm);
    if (!res.allowed && !res.reason) res.reason = 'rate_limit_exceeded';
    return res;
  }

  async recordVerify(req) {
    const ownerId = req.keyId || req.ip;
    await this._increment(ownerId, 'verify', 60, 1);
  }

  async checkSettle(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);

    // Check all three limits for settle
    const checks = [
      await this._check(ownerId, 'settle', 60, limits.settleRpm),
      await this._check(ownerId, 'settle', 3600, limits.settleRph),
      await this._check(ownerId, 'settle', 86400, limits.settleRpd),
    ];

    for (const c of checks) {
      if (!c.allowed) return { ...c, reason: c.reason || 'rate_limit_exceeded' };
    }

    // Check fee limit
    // We can't strictly check fee before settlement unless we assume maxTransactionFeeStroops.
    // We will check if the current consumed + 0 is > limits.feeSpd (or maxTransactionFeeStroops).
    const feeCheck = await this._check(ownerId, 'fee', 86400, limits.feeSpd, 0); // just checking current
    if (!feeCheck.allowed) {
      return { ...feeCheck, reason: feeCheck.reason || 'fee_ceiling_exceeded' };
    }

    // Return the tightest limit for headers
    return checks.reduce((tightest, current) =>
      current.remaining < tightest.remaining ? current : tightest,
    );
  }

  async recordSettle(req, feeCharged) {
    const ownerId = req.keyId || req.ip;
    await this._increment(ownerId, 'settle', 60, 1);
    await this._increment(ownerId, 'settle', 3600, 1);
    await this._increment(ownerId, 'settle', 86400, 1);
    if (feeCharged > 0) {
      await this._increment(ownerId, 'fee', 86400, feeCharged);
    }
  }

  /**
   * Catalogue writes are metered per minute (the same fix upstream landed in
   * #240; this method previously reached for `this.limits`, which never
   * existed, and threw on every call). Async here because bucket state lives
   * behind the shared store (#94).
   */
  async checkCatalog(req) {
    // Both check and record key on req.keyId || req.ip to share a single catalog budget for unauthenticated callers per IP, or per authenticated caller regardless of IP.
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const res = await this._check(ownerId, 'catalog', 60, limits.catalogRpm);
    if (!res.allowed && !res.reason) res.reason = 'catalog_rate_limited';
    return res;
  }

  async recordCatalog(req) {
    const ownerId = req.keyId || req.ip;
    await this._increment(ownerId, 'catalog', 60, 1);
  }

  async getUsage(keyId) {
    const ownerId = keyId; // IP usage is not exposed via GET /usage, only key usage
    const getCount = async (type, windowSec, fallback) => {
      const now = Math.floor(Date.now() / 1000);
      try {
        const bucket = await this.store.get(this._getBucketId(ownerId, type, windowSec), now);
        return bucket?.count ?? 0;
      } catch {
        // Usage reporting is informational; a dead shared store must not turn
        // GET /usage into a 500. Report the last known zero rather than fail.
        return fallback;
      }
    };
    return {
      verify_rpm: await getCount('verify', 60),
      settle_rpm: await getCount('settle', 60),
      settle_rph: await getCount('settle', 3600),
      settle_rpd: await getCount('settle', 86400),
      fee_spd: await getCount('fee', 86400),
    };
  }
}
