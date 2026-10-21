/* global setInterval, clearInterval */
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
import net from 'node:net';
import { MemoryStore } from './rate-limit-store.js';
import { ipMatchesCidr } from './trust-proxy.js';

/** True when `entry` is a bare IP or an IP/prefix pair the matcher can use. */
function isValidCidr(entry) {
  const slash = entry.lastIndexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const kind = net.isIP(address);
  if (kind === 0) return false;
  if (slash === -1) return true;
  const prefix = Number(entry.slice(slash + 1));
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= (kind === 6 ? 128 : 32);
}

export class RateLimiter {
  /**
   * @param {object} config - { global: {...}, keys: {...}, perNetwork: {...},
   *   allowlist?: string[] } limits
   * @param {{get: Function, increment: Function, sweep: Function}} [store]
   *   Defaults to in-process memory. Pass a shared store to enforce combined
   *   limits across replicas; two limiters pointed at one store behave as one.
   * @param {{audit?: Function}} [options] - audit sink for bypass records
   */
  constructor(config, store = new MemoryStore(), { audit = null } = {}) {
    this.config = config;
    this.store = store;
    this.audit = audit;
    this.allowlist = Array.isArray(config.allowlist) ? config.allowlist : [];
    for (const entry of this.allowlist) {
      // A typo must fail at boot, where a restart fixes it, instead of silently
      // matching nobody on every request.
      if (!isValidCidr(entry)) {
        throw new Error(`RATE_LIMIT_ALLOWLIST entries must be IPs or CIDRs — got "${entry}".`);
      }
    }
    this._sweepInterval = null;
    this._startSweepInterval();
  }

  /** Late-bound so createApp can hand the limiter the app's audit sink. */
  setAudit(audit) {
    this.audit = audit;
  }

  /**
   * Returns the matched allowlist CIDR for this request, or null. Only the
   * resolved `req.ip` is consulted: the trust-proxy hook has already decided
   * whether an X-Forwarded-For entry may be believed, so a forged header
   * cannot spoof an allowlisted address (#410).
   */
  _allowlistMatch(req) {
    if (!req || typeof req.ip !== 'string' || this.allowlist.length === 0) return null;
    return this.allowlist.find(cidr => ipMatchesCidr(req.ip, cidr)) ?? null;
  }

  /**
   * Short-circuits a limit check for a trusted source and records the bypass
   * in the audit channel. Reads are not consumed: an allowlisted caller is
   * never counted, so its quota is untouched.
   */
  _bypass(req, route, limit, windowSec = 60) {
    const cidr = this._allowlistMatch(req);
    if (!cidr) return null;
    this.audit?.('rate_limit_bypass', {
      actor: req.keyId ? `key:${req.keyId}` : `ip:${req.ip}`,
      route,
      cidr,
    });
    return {
      allowed: true,
      bypassed: true,
      limit,
      remaining: limit,
      resetAt: Math.floor(Date.now() / 1000) + windowSec,
    };
  }

  _startSweepInterval() {
    // Deterministic sweep every 60 seconds instead of probabilistic 5% coin flip
    this._sweepInterval = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      this._sweep(now).catch(err => {
        console.error(`[RateLimit] scheduled sweep failed: ${err.message}`);
      });
    }, 60000).unref(); // unref() allows process to exit if this is the only timer
  }

  close() {
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }
  }

  _getKeyConfig(keyId) {
    // Normalize key id to uppercase for case-insensitive lookup
    const normalizedKeyId = keyId ? keyId.toUpperCase() : keyId;
    return this.config.keys[normalizedKeyId] || this.config.global;
  }

  _getBucketId(ownerId, type, windowSec) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSec);
    return `${ownerId}:${type}:${windowStart}:${windowSec}`;
  }

  _computeResetAt(now, windowSec) {
    const windowStart = now - (now % windowSec);
    return windowStart + windowSec;
  }

  async _increment(ownerId, type, windowSec, amount = 1) {
    const now = Math.floor(Date.now() / 1000);
    const bucketId = this._getBucketId(ownerId, type, windowSec);
    const resetAt = this._computeResetAt(now, windowSec);

    try {
      const bucket = await this.store.increment(bucketId, amount, resetAt, now);
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
      // Sweep on read as well as write to handle rejection-only traffic
      await this._sweep(now);
    } catch {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: this._computeResetAt(now, windowSec),
        reason: 'rate_limit_store_unavailable',
      };
    }
    const resetAt = bucket?.resetAt ?? this._computeResetAt(now, windowSec);
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
    const bypass = this._bypass(req, 'verify', limits.verifyRpm);
    if (bypass) return bypass;
    const res = await this._check(ownerId, 'verify', 60, limits.verifyRpm);
    if (!res.allowed && !res.reason) res.reason = 'rate_limit_exceeded';
    return res;
  }

  /**
   * Given a post-increment bucket, derive the remaining allowance after the
   * current request was counted. Counts are asserted finite: a lost/failed
   * record (the transport degrades open on store failure) is treated as one
   * consumed so the advertised remaining is never above the true headroom.
   */
  _postRecordRemaining(limit, bucket) {
    const count = Number.isFinite(bucket?.count) ? bucket.count : 1;
    return Math.max(0, limit - count);
  }

  /**
   * Records this verify and returns the limiter state AFTER the request was
   * counted, so the transport can advertise a remaining value that reflects
   * what the caller truly has left (issue #141): `recordVerify` post-dates the
   * `checkVerify` whose `remaining` is only a projection until this runs.
   *
   * @returns {{allowed: true, limit: number, remaining: number, resetAt: number}}
   */
  async recordVerify(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const bucket = await this._increment(ownerId, 'verify', 60, 1);
    const limit = limits.verifyRpm;
    return {
      allowed: true,
      limit,
      remaining: this._postRecordRemaining(limit, bucket),
      resetAt: bucket?.resetAt,
    };
  }

  async checkSettle(req, network = null) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const bypass = this._bypass(req, 'settle', limits.settleRpm);
    if (bypass) return bypass;

    // Check all three limits for settle
    const checks = [
      await this._check(ownerId, 'settle', 60, limits.settleRpm),
      await this._check(ownerId, 'settle', 3600, limits.settleRph),
      await this._check(ownerId, 'settle', 86400, limits.settleRpd),
    ];

    for (const c of checks) {
      if (!c.allowed) return { ...c, reason: c.reason || 'rate_limit_exceeded' };
    }

    // Check fee limit with maxTransactionFeeStroops reservation
    // Use the network's max fee to conservatively reserve the worst-case cost
    const maxFee = network
      ? (this.config.perNetwork?.[network]?.maxTransactionFeeStroops ?? 50000)
      : 50000;
    const feeCheck = await this._check(ownerId, 'fee', 86400, limits.feeSpd, maxFee);
    if (!feeCheck.allowed) {
      return { ...feeCheck, reason: feeCheck.reason || 'fee_ceiling_exceeded' };
    }

    // Return the tightest limit for headers
    return checks.reduce((tightest, current) =>
      current.remaining < tightest.remaining ? current : tightest,
    );
  }

  /**
   * Records this settlement and returns the limiter state AFTER the request was
   * counted (issue #141): the tightest remaining allowance across the per-minute,
   * per-hour and per-day buckets, advertised as RateLimit-* so it reflects what
   * the caller truly has left rather than the pre-record projection.
   *
   * @returns {{allowed: true, limit: number, remaining: number, resetAt: number}}
   */
  async recordSettle(req, feeCharged) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const b60 = await this._increment(ownerId, 'settle', 60, 1);
    const b3600 = await this._increment(ownerId, 'settle', 3600, 1);
    const b86400 = await this._increment(ownerId, 'settle', 86400, 1);
    if (feeCharged > 0) {
      await this._increment(ownerId, 'fee', 86400, feeCharged);
    }
    const tightest = [
      { limit: limits.settleRpm, remaining: this._postRecordRemaining(limits.settleRpm, b60) },
      {
        limit: limits.settleRph,
        remaining: this._postRecordRemaining(limits.settleRph, b3600),
      },
      {
        limit: limits.settleRpd,
        remaining: this._postRecordRemaining(limits.settleRpd, b86400),
      },
    ].sort((a, b) => a.remaining - b.remaining)[0];
    return {
      allowed: true,
      limit: tightest.limit,
      remaining: tightest.remaining,
      resetAt: b60?.resetAt,
    };
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
    const bypass = this._bypass(req, 'catalog', limits.catalogRpm);
    if (bypass) return bypass;
    const res = await this._check(ownerId, 'catalog', 60, limits.catalogRpm);
    if (!res.allowed && !res.reason) res.reason = 'catalog_rate_limited';
    return res;
  }

  /**
   * Records a catalogue write and returns the limiter state AFTER the request
   * was counted, the same shape `recordVerify` returns (#209). The transport
   * advertises `RateLimit-*` from whichever state it is handed — returning the
   * post-record one keeps the two write paths consistent instead of leaving
   * this call site to fall back to a pre-record projection.
   *
   * @returns {{allowed: true, limit: number, remaining: number, resetAt: number}}
   */
  async recordCatalog(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const bucket = await this._increment(ownerId, 'catalog', 60, 1);
    return {
      allowed: true,
      limit: limits.catalogRpm,
      remaining: this._postRecordRemaining(limits.catalogRpm, bucket),
      resetAt: bucket?.resetAt,
    };
  }

  /**
   * Catalogue reads are metered separately from writes with their own bucket.
   * Reads are cheaper than writes but still bounded to prevent abuse.
   */
  async checkCatalogRead(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const bypass = this._bypass(req, 'catalog_read', limits.catalogReadRpm ?? 60);
    if (bypass) return bypass;
    const res = await this._check(ownerId, 'catalog_read', 60, limits.catalogReadRpm ?? 60);
    if (!res.allowed && !res.reason) res.reason = 'catalog_read_rate_limited';
    return res;
  }

  /**
   * Records a catalogue read and returns the post-record state, mirroring
   * `recordCatalog` (#209).
   *
   * @returns {{allowed: true, limit: number, remaining: number, resetAt: number}}
   */
  async recordCatalogRead(req) {
    const ownerId = req.keyId || req.ip;
    const limit = this._getKeyConfig(req.keyId).catalogReadRpm ?? 60;
    const bucket = await this._increment(ownerId, 'catalog_read', 60, 1);
    return {
      allowed: true,
      limit,
      remaining: this._postRecordRemaining(limit, bucket),
      resetAt: bucket?.resetAt,
    };
  }

  async getUsage(keyId) {
    const ownerId = keyId; // IP usage is not exposed via GET /usage, only key usage
    const limits = this._getKeyConfig(keyId);
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
      catalog_rpm: await getCount('catalog', 60),
      limits: {
        verify_rpm: limits.verifyRpm,
        settle_rpm: limits.settleRpm,
        settle_rph: limits.settleRph,
        settle_rpd: limits.settleRpd,
        fee_spd: limits.feeSpd,
        catalog_rpm: limits.catalogRpm,
      },
    };
  }
}
