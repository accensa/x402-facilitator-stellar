/**
 * Redis-backed rate limiter for multi-instance deployments.
 *
 * The in-memory RateLimiter keeps one Map per process. Behind a load balancer
 * every instance has its own counters, so limits are effectively multiplied by
 * the instance count and usage reporting is per-node. This subclass moves the
 * buckets into Redis with a TTL equal to the window, so all instances share one
 * counter set and stale buckets expire on their own.
 *
 * Graceful degradation: if Redis is unreachable at boot or fails mid-flight,
 * operations fall back to the in-memory parent implementation and a warning is
 * logged once per outage. Rate limiting degrades to per-instance accuracy; it
 * never takes the service down.
 */
import { RateLimiter } from './rate-limit.js';

export class RedisRateLimiter extends RateLimiter {
  /**
   * @param {object} config - { global: {...}, keys: {...}, perNetwork: {...} } limits
   * @param {object} options
   * @param {object} [options.client] - an ioredis-compatible client. Injected
   *   in tests; when omitted, ioredis is imported lazily.
   * @param {string} options.redisUrl - redis:// connection URL
   * @param {Function} [options.warn] - warning sink, defaults to console.warn
   */
  constructor(config, { client, redisUrl, warn = msg => console.warn(msg) } = {}) {
    super(config);
    this.redis = client ?? null;
    this.warn = warn;
    this.degraded = false;
    this.external = Boolean(client);
    if (!this.redis && redisUrl) {
      // Lazy import so the process still boots if the optional dependency is
      // missing entirely — it then runs fully in memory.
      import('ioredis')
        .then(({ default: Redis }) => {
          this.redis = new Redis(redisUrl);
          this.redis.on('error', err => this._degrade(`Redis error: ${err.message}`));
          this.redis.on('ready', () => this._recover());
        })
        .catch(err => this._degrade(`Redis unavailable (${err.message}); using in-memory buckets`));
    }
  }

  _degrade(message) {
    if (!this.degraded) {
      this.degraded = true;
      this.warn(`[RateLimit] ${message} — rate limits are now per-instance`);
    }
  }

  _recover() {
    if (this.degraded) {
      this.degraded = false;
      this.warn('[RateLimit] Redis reconnected — shared buckets restored');
    }
  }

  /** Runs fn against Redis; falls back to the in-memory path on any failure. */
  async _withRedis(fn, fallback) {
    if (!this.redis || this.degraded || this.redis.status === 'end') return fallback();
    try {
      return await fn(this.redis);
    } catch (err) {
      this._degrade(`Redis operation failed: ${err.message}`);
      return fallback();
    }
  }

  async _incrementAsync(ownerId, type, windowSec, amount = 1) {
    const bucketId = `ratelimit:${this._getBucketId(ownerId, type, windowSec)}`;
    const now = Math.floor(Date.now() / 1000);
    const resetAt = now - (now % windowSec) + windowSec;
    return this._withRedis(
      async redis => {
        // Atomic counter with TTL: INCR then set expiry only on first hit.
        const count = await redis.incr(bucketId);
        if (count === 1) await redis.expire(bucketId, windowSec + 1);
        return { count, resetAt };
      },
      () =>
        // The parent's buckets live behind the store interface (#94): async
        // increment returns the resulting bucket.
        super._increment(ownerId, type, windowSec, amount).then(bucket => ({
          count: bucket?.count ?? amount,
          resetAt,
        })),
    );
  }

  async _checkAsync(ownerId, type, windowSec, limit, amount = 1) {
    const bucketId = `ratelimit:${this._getBucketId(ownerId, type, windowSec)}`;
    const now = Math.floor(Date.now() / 1000);
    const resetAt = now - (now % windowSec) + windowSec;
    return this._withRedis(
      async redis => {
        const count = Number((await redis.get(bucketId)) ?? 0);
        if (count + amount > limit) return { allowed: false, limit, remaining: 0, resetAt };
        return { allowed: true, limit, remaining: limit - count - amount, resetAt };
      },
      // The parent's _check is async since #94 and already computes resetAt.
      () => this._check(ownerId, type, windowSec, limit, amount),
    );
  }

  // The public surface becomes async; app.js already awaits nothing on these,
  // but Promise-wrapping keeps callers uniform.

  checkVerify(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    return this._checkAsync(ownerId, 'verify', 60, limits.verifyRpm).then(res => {
      if (!res.allowed) res.reason = 'rate_limit_exceeded';
      return res;
    });
  }

  async recordVerify(req) {
    const ownerId = req.keyId || req.ip;
    await this._incrementAsync(ownerId, 'verify', 60, 1);
  }

  async checkSettle(req, _network = null) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const checks = [
      await this._checkAsync(ownerId, 'settle', 60, limits.settleRpm),
      await this._checkAsync(ownerId, 'settle', 3600, limits.settleRph),
      await this._checkAsync(ownerId, 'settle', 86400, limits.settleRpd),
    ];
    for (const c of checks) {
      if (!c.allowed) return { ...c, reason: 'rate_limit_exceeded' };
    }
    // Use 50000 as default max fee if config.perNetwork is not available
    const maxFee = 50000;
    const feeCheck = await this._checkAsync(ownerId, 'fee', 86400, limits.feeSpd, maxFee);
    if (!feeCheck.allowed) return { ...feeCheck, reason: 'fee_ceiling_exceeded' };
    return checks.reduce((tightest, current) =>
      current.remaining < tightest.remaining ? current : tightest,
    );
  }

  async recordSettle(req, feeCharged) {
    const ownerId = req.keyId || req.ip;
    await this._incrementAsync(ownerId, 'settle', 60, 1);
    await this._incrementAsync(ownerId, 'settle', 3600, 1);
    await this._incrementAsync(ownerId, 'settle', 86400, 1);
    if (feeCharged) await this._incrementAsync(ownerId, 'fee', 86400, feeCharged);
  }

  checkCatalog(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    return this._checkAsync(ownerId, 'catalog', 60, limits.catalogRpm).then(res => {
      if (!res.allowed) res.reason = 'catalog_rate_limited';
      return res;
    });
  }

  async recordCatalog(req) {
    const ownerId = req.keyId || req.ip;
    await this._incrementAsync(ownerId, 'catalog', 60, 1);
  }

  /**
   * Catalogue reads are metered separately from writes with their own bucket
   * (catalogReadRpm), mirroring the memory limiter in src/rate-limit.js.
   */
  checkCatalogRead(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    return this._checkAsync(ownerId, 'catalog_read', 60, limits.catalogReadRpm ?? 60).then(res => {
      if (!res.allowed) res.reason = 'catalog_read_rate_limited';
      return res;
    });
  }

  async recordCatalogRead(req) {
    const ownerId = req.keyId || req.ip;
    await this._incrementAsync(ownerId, 'catalog_read', 60, 1);
  }

  async getUsage(keyId) {
    // Degraded / no Redis: the parent's implementation already reads the
    // in-memory store through the store interface (#94).
    const readMemory = () => super.getUsage(keyId);
    if (!this.redis || this.degraded || this.redis.status === 'end') return readMemory();
    try {
      const ownerId = keyId;
      const limits = this._getKeyConfig(keyId);
      const types = [
        ['verify_rpm', 'verify', 60],
        ['settle_rpm', 'settle', 60],
        ['settle_rph', 'settle', 3600],
        ['settle_rpd', 'settle', 86400],
        ['fee_spd', 'fee', 86400],
        ['catalog_rpm', 'catalog', 60],
      ];
      const counts = {};
      for (const [name, type, windowSec] of types) {
        counts[name] = Number(
          (await this.redis.get(`ratelimit:${this._getBucketId(ownerId, type, windowSec)}`)) ?? 0,
        );
      }
      counts.limits = {
        verify_rpm: limits.verifyRpm,
        settle_rpm: limits.settleRpm,
        settle_rph: limits.settleRph,
        settle_rpd: limits.settleRpd,
        fee_spd: limits.feeSpd,
        catalog_rpm: limits.catalogRpm,
      };
      return counts;
    } catch (err) {
      this._degrade(`Redis operation failed: ${err.message}`);
      return readMemory();
    }
  }
}
