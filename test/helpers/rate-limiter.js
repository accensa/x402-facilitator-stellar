/**
 * Rate-limiter test double, kept free of any src/app.js import.
 *
 * It lives apart from ./app.js so a suite that only needs the stub (e.g. the
 * stub-vs-real contract test in rate-limit.test.js) does not pay for loading
 * the whole HTTP app graph. ./app.js re-exports it unchanged.
 */

/**
 * A rate limiter that allows everything and records what it was told.
 *
 * `allow: false` flips it to refusing, which is how the 429 path and its
 * headers get exercised without waiting out a real window.
 */
export function stubRateLimiter({ allow = true, reason = 'verify_rpm_exceeded' } = {}) {
  const resetAt = Math.floor(Date.now() / 1000) + 60;
  const result = () => ({ allowed: allow, limit: 60, remaining: allow ? 59 : 0, resetAt, reason });
  const recorded = [];
  return {
    recorded,
    checkVerify: () => result(),
    checkSettle: () => result(),
    checkCatalog: () => result(),
    checkCatalogRead: () => result(),
    recordCatalog: req => {
      recorded.push({ name: 'recordCatalog', keyId: req.keyId });
      return result();
    },
    recordCatalogRead: req => {
      recorded.push({ name: 'recordCatalogRead', keyId: req.keyId });
      return result();
    },
    recordVerify: req => {
      recorded.push({ name: 'recordVerify', keyId: req.keyId });
      return result();
    },
    recordSettle: (req, fee) => {
      recorded.push({ name: 'recordSettle', keyId: req.keyId, fee });
      return result();
    },
    getUsage: keyId => ({ keyId, verify: 1, settle: 2, feeStroops: 3000 }),
  };
}
