/**
 * RateLimiter unit tests (src/rate-limit.js).
 *
 * What is pinned here:
 *   - the fixed-window counters per dimension (verify/settle rpm/rph/rpd,
 *     catalog writes, catalog reads) and the daily fee ceiling with its
 *     worst-case fee reservation;
 *   - owner resolution: API key first (case-insensitive), client IP otherwise;
 *   - the degrade decision at the top of src/rate-limit.js — checks fail
 *     CLOSED on a store error, records degrade OPEN, sweeps never throw;
 *   - that stubRateLimiter (used by the HTTP suites) cannot drift from the
 *     real limiter's surface, and that the real limiter is wired into the app.
 *
 * Testing strategy: every limiter runs over the in-memory store unless a test
 * is specifically about store failure, in which case a store whose operations
 * reject is injected (see failingStore). Time is real — windows are 60s and
 * longer, so a single test never crosses one — except where the sweep timer
 * itself is under test, which uses node:test mock timers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { MemoryStore } from '../src/rate-limit-store.js';
import { stubRateLimiter } from './helpers/rate-limiter.js';

/**
 * Global limits loose enough that none of them trips unless a test lowers it.
 * Each test overrides only the dimensions it exercises.
 */
const DEFAULT_LIMITS = { verifyRpm: 10, settleRpm: 10, settleRph: 10, settleRpd: 10, feeSpd: 500 };

/** Worst-case fee checkSettle reserves when no per-network max is configured. */
const DEFAULT_FEE_RESERVATION = 50000;

/**
 * Builds a RateLimiter and closes it when the test ends. Every RateLimiter
 * starts a 60s sweep interval; without close() each test would leave one
 * behind for the life of the process.
 *
 * @param {import('node:test').TestContext} t - the running test, for teardown
 * @param {object} [options]
 * @param {object} [options.global] - overrides merged over DEFAULT_LIMITS
 * @param {object} [options.keys] - per-key limit overrides, keyed by uppercase id
 * @param {object} [options.perNetwork] - per-network config (maxTransactionFeeStroops)
 * @param {object} [options.store] - bucket store; defaults to a fresh MemoryStore
 * @returns {RateLimiter}
 */
function newLimiter(t, { global = {}, keys = {}, perNetwork, store = new MemoryStore() } = {}) {
  const limiter = new RateLimiter(
    { global: { ...DEFAULT_LIMITS, ...global }, keys, perNetwork },
    store,
  );
  t.after(() => limiter.close());
  return limiter;
}

/**
 * Asserts `check<kind>` allows `req`, then consumes one unit with
 * `record<kind>` — the check-then-record order the HTTP routes use.
 *
 * @param {RateLimiter} limiter
 * @param {'Verify'|'Settle'|'Catalog'|'CatalogRead'} kind - method suffix
 * @param {{keyId?: string, ip?: string}} req - the caller identity
 * @param {...unknown} recordArgs - extra args for record<kind> (e.g. fee charged)
 */
async function admit(limiter, kind, req, ...recordArgs) {
  const res = await limiter[`check${kind}`](req);
  assert.equal(
    res.allowed,
    true,
    `check${kind} should allow before recording; got ${JSON.stringify(res)}`,
  );
  await limiter[`record${kind}`](req, ...recordArgs);
}

/**
 * Asserts `check<kind>` refuses `req`, and with `reason` when one is given.
 * The failure message carries the whole result so a wrong reason (or an
 * unexpected allow) is diagnosable from the test output alone.
 *
 * @param {RateLimiter} limiter
 * @param {'Verify'|'Settle'|'Catalog'|'CatalogRead'} kind - method suffix
 * @param {{keyId?: string, ip?: string}} req - the caller identity
 * @param {string} [reason] - the expected refusal reason code
 * @returns {Promise<object>} the refusal, for further assertions
 */
async function assertRefused(limiter, kind, req, reason) {
  const res = await limiter[`check${kind}`](req);
  assert.equal(res.allowed, false, `check${kind} should refuse; got ${JSON.stringify(res)}`);
  if (reason) assert.equal(res.reason, reason, `check${kind} refused for the wrong reason`);
  return res;
}

/**
 * A bucket store whose listed operations reject, standing in for a shared
 * store (Postgres/Redis) that has become unreachable. Unlisted operations
 * behave like a healthy, empty store.
 *
 * @param {Array<'get'|'increment'|'sweep'>} failing - operations that reject
 * @returns {{get: Function, increment: Function, sweep: Function}}
 */
function failingStore(failing) {
  const healthy = new MemoryStore();
  const store = {};
  for (const op of ['get', 'increment', 'sweep']) {
    store[op] = failing.includes(op)
      ? async () => {
          throw new Error(`store ${op} unreachable`);
        }
      : healthy[op].bind(healthy);
  }
  return store;
}

test('rate limiter honors global limits', async t => {
  const limiter = newLimiter(t, {
    global: { verifyRpm: 2, settleRpm: 1, settleRpd: 100, feeSpd: 50500 },
  });
  const req = { keyId: 'TEST_KEY' };

  await admit(limiter, 'Verify', req);
  await admit(limiter, 'Verify', req);
  await assertRefused(limiter, 'Verify', req);

  await admit(limiter, 'Settle', req, 500);
  await assertRefused(limiter, 'Settle', req); // RPM exceeded

  const usage = await limiter.getUsage('TEST_KEY');
  assert.equal(usage.verify_rpm, 2);
  assert.equal(usage.settle_rpm, 1);
  assert.equal(usage.fee_spd, 500);
});

test('rate limiter honors per-key overrides', async t => {
  const tight = { verifyRpm: 1, settleRpm: 1, settleRpd: 100, feeSpd: 1000 };
  const limiter = newLimiter(t, {
    global: tight,
    keys: { TEST_KEY: { ...DEFAULT_LIMITS, ...tight, verifyRpm: 5 } },
  });
  const req = { keyId: 'TEST_KEY' };

  await limiter.recordVerify(req);
  await limiter.recordVerify(req);
  assert.equal((await limiter.checkVerify(req)).allowed, true); // Since limit is 5
});

test('rate limiter halts on fee ceiling', async t => {
  // checkSettle reserves the worst-case max fee (50000 stroops by default)
  // against feeSpd before every settlement (Option B), so the ceiling must
  // sit just above the reservation to let the first checks through.
  const limiter = newLimiter(t, { global: { feeSpd: 50500 } });
  const req = { keyId: 'TEST_KEY' };

  await admit(limiter, 'Settle', req, 400);
  // 400 + 200 = 600 consumed; 600 + 50000 reservation clears 50500.
  await admit(limiter, 'Settle', req, 200);

  await assertRefused(limiter, 'Settle', req, 'fee_ceiling_exceeded');
});

test('rate limiter falls back to IP in open mode', async t => {
  const limiter = newLimiter(t, {
    global: { verifyRpm: 1, settleRpm: 1, settleRpd: 100, feeSpd: 1000 },
  });
  const req1 = { ip: '192.168.1.1' };
  const req2 = { ip: '192.168.1.2' };

  await admit(limiter, 'Verify', req1);
  await assertRefused(limiter, 'Verify', req1);

  // req2 should still be allowed since it's a different IP
  assert.equal((await limiter.checkVerify(req2)).allowed, true);
});

test('rate limiter sweeps expired buckets', async t => {
  const limiter = newLimiter(t, {
    global: { verifyRpm: 1, settleRpm: 1, settleRpd: 100, feeSpd: 1000, catalogRpm: 1 },
  });
  const now = Math.floor(Date.now() / 1000);

  // Directly inject an expired bucket
  limiter.store.map.set('catalog:127.0.0.1:60', { count: 5, resetAt: now - 10 });
  await limiter._sweep(now);
  assert.equal(limiter.store.map.has('catalog:127.0.0.1:60'), false);
});

test('close() stops the sweep interval and is safe to call twice', t => {
  const limiter = newLimiter(t);
  assert.ok(limiter._sweepInterval, 'the constructor should start the sweep interval');

  limiter.close();
  assert.equal(limiter._sweepInterval, null);
  // newLimiter's teardown closes it again; that second call must be a no-op.
  assert.doesNotThrow(() => limiter.close());
});

test('stubRateLimiter matches the real limiter surface and return shapes', async t => {
  const real = newLimiter(t, { global: { catalogRpm: 10, catalogReadRpm: 10 } });
  const stub = stubRateLimiter();

  // Derived from the stub, never hardcoded: a literal list here goes stale the
  // moment the stub grows a method, and a stale contract test is exactly the
  // blind spot #189 is about. (checkCatalogRead/recordCatalogRead were added
  // after this test was first written, and a hardcoded list missed them.)
  const stubMethods = Object.keys(stub)
    .filter(key => typeof stub[key] === 'function')
    .sort();
  assert.ok(stubMethods.length > 0, 'the stub should fake at least one method');

  for (const method of stubMethods) {
    assert.equal(
      typeof real[method],
      'function',
      `stubRateLimiter fakes ${method}(), but the real RateLimiter has no such method`,
    );
  }

  // Every check* the stub fakes must return the same shape as the real one,
  // or a test that passes against the stub proves nothing about production.
  const req = { ip: '127.0.0.1' };
  for (const method of stubMethods.filter(m => m.startsWith('check'))) {
    const realResult = await real[method](req);
    const stubResult = await stub[method](req);
    for (const key of ['allowed', 'limit', 'remaining', 'resetAt']) {
      assert.equal(
        typeof stubResult[key],
        typeof realResult[key],
        `${method}(): stub returns ${typeof stubResult[key]} for ${key}, real returns ${typeof realResult[key]}`,
      );
    }
  }
});

test('real RateLimiter serves all payment and discovery routes', async t => {
  // Loaded here, not at the top: the app graph (Fastify, Stellar SDK, ...) is
  // by far the most expensive import in this file and only this test needs it,
  // so a filtered run of the unit tests above never pays for it.
  const { serve, testConfig, VALID_BODY } = await import('./helpers/app.js');
  const rateLimiter = newLimiter(t, { global: { feeSpd: 500000, catalogRpm: 10 } });
  const app = await serve({
    config: testConfig(),
    rateLimiter,
    catalog: {
      upsertResource: async resource => resource,
      listResources: async () => ({ items: [], total: 0 }),
      search: async () => ({ resources: [], partialResults: false, pagination: {} }),
    },
  });
  try {
    assert.equal((await app.post('/verify', VALID_BODY)).status, 200);
    assert.equal((await app.post('/settle', VALID_BODY)).status, 200);
    assert.equal((await app.get('/discovery/resources')).status, 200);
    assert.equal((await app.get('/discovery/search?query=stellar')).status, 200);
  } finally {
    await app.close();
  }
});

test('catalog limiter enforces limits', async t => {
  const limiter = newLimiter(t, {
    global: { catalogRpm: 2 },
    keys: { CUSTOM_KEY: { catalogRpm: 1 } },
  });

  // Test global limit (2 RPM)
  const req1 = { ip: '127.0.0.1' };
  await admit(limiter, 'Catalog', req1);
  await admit(limiter, 'Catalog', req1);
  await assertRefused(limiter, 'Catalog', req1, 'catalog_rate_limited');

  // Test per-key limit (1 RPM)
  const req2 = { keyId: 'CUSTOM_KEY', ip: '127.0.0.1' };
  await admit(limiter, 'Catalog', req2);
  await assertRefused(limiter, 'Catalog', req2, 'catalog_rate_limited');
});

// ---------------------------------------------------------------------------
// Dimensions and owner resolution the tests above do not reach.
// ---------------------------------------------------------------------------

test('per-key lookup is case-insensitive', async t => {
  const limiter = newLimiter(t, {
    global: { verifyRpm: 1 },
    keys: { MIXED_KEY: { ...DEFAULT_LIMITS, verifyRpm: 3 } },
  });
  // Auth normalizes ids to uppercase, but the limiter must not depend on it.
  const res = await limiter.checkVerify({ keyId: 'mixed_key' });
  assert.equal(res.limit, 3);
});

test('checkSettle reserves the per-network max fee, else the default', async t => {
  const limiter = newLimiter(t, {
    global: { feeSpd: 20000 },
    perNetwork: { 'stellar:testnet': { maxTransactionFeeStroops: 10000 } },
  });
  const req = { keyId: 'K' };

  // A 10k reservation fits under the 20k ceiling on the configured network...
  assert.equal((await limiter.checkSettle(req, 'stellar:testnet')).allowed, true);
  // ...while an unconfigured network (or none) reserves the default, which
  // is larger than the whole ceiling.
  assert.ok(DEFAULT_FEE_RESERVATION > 20000);
  await assertRefused(limiter, 'Settle', req, 'fee_ceiling_exceeded');
  const unknown = await limiter.checkSettle(req, 'stellar:pubnet');
  assert.equal(unknown.reason, 'fee_ceiling_exceeded');
});

test('checkSettle advertises the tightest of the three settle windows', async t => {
  const limiter = newLimiter(t, {
    global: { settleRpm: 5, settleRph: 2, settleRpd: 9, feeSpd: 10 * DEFAULT_FEE_RESERVATION },
  });
  const res = await limiter.checkSettle({ keyId: 'K' });
  assert.equal(res.allowed, true);
  assert.equal(res.limit, 2);
  assert.equal(res.remaining, 1);
});

test('the per-hour settle window refuses once the per-minute one still has room', async t => {
  const limiter = newLimiter(t, {
    global: { settleRpm: 5, settleRph: 1, feeSpd: 10 * DEFAULT_FEE_RESERVATION },
  });
  const req = { keyId: 'K' };
  await admit(limiter, 'Settle', req, 0);
  await assertRefused(limiter, 'Settle', req, 'rate_limit_exceeded');
});

test('recordVerify and recordSettle report the post-count state', async t => {
  const limiter = newLimiter(t, { global: { verifyRpm: 3, settleRpm: 4, settleRph: 2 } });
  const req = { keyId: 'K' };

  const verify = await limiter.recordVerify(req);
  assert.equal(verify.allowed, true);
  assert.equal(verify.limit, 3);
  assert.equal(verify.remaining, 2);
  assert.equal(typeof verify.resetAt, 'number');

  // The tightest window after counting is the per-hour one (2 - 1 = 1 left).
  const settle = await limiter.recordSettle(req, 0);
  assert.equal(settle.limit, 2);
  assert.equal(settle.remaining, 1);
});

test('a zero fee is not recorded against the daily fee ceiling', async t => {
  const limiter = newLimiter(t);
  await limiter.recordSettle({ keyId: 'K' }, 0);
  const usage = await limiter.getUsage('K');
  assert.equal(usage.settle_rpm, 1);
  assert.equal(usage.fee_spd, 0);
});

test('getUsage reports every counter alongside the configured limits', async t => {
  const limiter = newLimiter(t, { global: { catalogRpm: 7 } });
  const req = { keyId: 'K' };
  await limiter.recordVerify(req);
  await limiter.recordSettle(req, 250);
  await limiter.recordCatalog(req);

  assert.deepEqual(await limiter.getUsage('K'), {
    verify_rpm: 1,
    settle_rpm: 1,
    settle_rph: 1,
    settle_rpd: 1,
    fee_spd: 250,
    catalog_rpm: 1,
    limits: {
      verify_rpm: DEFAULT_LIMITS.verifyRpm,
      settle_rpm: DEFAULT_LIMITS.settleRpm,
      settle_rph: DEFAULT_LIMITS.settleRph,
      settle_rpd: DEFAULT_LIMITS.settleRpd,
      fee_spd: DEFAULT_LIMITS.feeSpd,
      catalog_rpm: 7,
    },
  });
});

test('catalog reads have their own bucket, defaulting to 60 per minute', async t => {
  const limiter = newLimiter(t, { global: { catalogRpm: 1 } });
  const req = { ip: '10.0.0.1' };

  // Exhausting the write budget leaves reads untouched.
  await admit(limiter, 'Catalog', req);
  await assertRefused(limiter, 'Catalog', req, 'catalog_rate_limited');
  const read = await limiter.checkCatalogRead(req);
  assert.equal(read.allowed, true);
  assert.equal(read.limit, 60);
});

test('catalog reads refuse with their own reason once the budget is spent', async t => {
  const limiter = newLimiter(t, { global: { catalogReadRpm: 1 } });
  const req = { ip: '10.0.0.1' };
  await admit(limiter, 'CatalogRead', req);
  await assertRefused(limiter, 'CatalogRead', req, 'catalog_read_rate_limited');
});

test('the sweep interval sweeps the store every 60 seconds', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sweeps = [];
  const store = { ...failingStore([]), sweep: async now => sweeps.push(now) };
  newLimiter(t, { store });

  t.mock.timers.tick(59_999);
  assert.equal(sweeps.length, 0);
  t.mock.timers.tick(1);
  assert.equal(sweeps.length, 1);
  // The sweep is told the current time in whole seconds.
  assert.ok(Number.isInteger(sweeps[0]));
});

// ---------------------------------------------------------------------------
// Store failure: the degrade decision documented at the top of
// src/rate-limit.js. Checks fail CLOSED with a distinct reason, records
// degrade OPEN (the payment already happened), sweeps are swallowed.
// ---------------------------------------------------------------------------

test('every check fails closed with rate_limit_store_unavailable when reads fail', async t => {
  const limiter = newLimiter(t, { store: failingStore(['get']) });
  const req = { keyId: 'K' };

  for (const kind of ['Verify', 'Settle', 'Catalog', 'CatalogRead']) {
    // The store's reason must survive: a route-specific reason here would
    // tell a caller they were over budget when the truth is "unknown".
    const res = await assertRefused(limiter, kind, req, 'rate_limit_store_unavailable');
    assert.equal(res.remaining, 0);
    assert.equal(typeof res.resetAt, 'number');
  }
});

test('a record that cannot reach the store degrades open and logs loudly', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const limiter = newLimiter(t, {
    global: { verifyRpm: 3, settleRpm: 3, settleRph: 3, settleRpd: 3 },
    store: failingStore(['increment']),
  });
  const req = { keyId: 'K' };

  // Neither record rejects: they run after the payment already succeeded.
  const verify = await limiter.recordVerify(req);
  const settle = await limiter.recordSettle(req, 100);
  await limiter.recordCatalog(req);
  await limiter.recordCatalogRead(req);

  // A lost count is treated as one consumed, never as headroom regained.
  assert.equal(verify.remaining, 2);
  assert.equal(settle.remaining, 2);
  assert.ok(
    errors.mock.calls.every(c => /count not recorded/.test(c.arguments[0])),
    'each lost record must be logged with the reason it was lost',
  );
  // verify + 4 settle increments (three windows and the fee) + catalog + read
  assert.equal(errors.mock.callCount(), 7);
});

test('a sweep failure never turns an allowed check into a refusal', async t => {
  const limiter = newLimiter(t, { store: failingStore(['sweep']) });
  const res = await limiter.checkVerify({ keyId: 'K' });
  assert.equal(res.allowed, true, `a failed sweep must be swallowed; got ${JSON.stringify(res)}`);
  await assert.doesNotReject(limiter._sweep(0));
});

test('getUsage never rejects when the store is unreachable', async t => {
  const limiter = newLimiter(t, { store: failingStore(['get']) });
  // GET /usage is informational: a dead store must not become a 500.
  const usage = await limiter.getUsage('K');
  assert.equal(usage.limits.verify_rpm, DEFAULT_LIMITS.verifyRpm);
});
