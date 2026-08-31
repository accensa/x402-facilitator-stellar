import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { stubRateLimiter, testConfig, VALID_BODY, serve } from './helpers/app.js';

test('rate limiter honors global limits', async () => {
  const config = {
    global: { verifyRpm: 2, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 50500 },
    keys: {},
  };
  const limiter = new RateLimiter(config);
  const req = { keyId: 'TEST_KEY' };

  // Verify
  assert.equal((await limiter.checkVerify(req)).allowed, true);
  await limiter.recordVerify(req);
  assert.equal((await limiter.checkVerify(req)).allowed, true);
  await limiter.recordVerify(req);
  assert.equal((await limiter.checkVerify(req)).allowed, false);

  // Settle
  assert.equal((await limiter.checkSettle(req)).allowed, true);
  await limiter.recordSettle(req, 500);
  assert.equal((await limiter.checkSettle(req)).allowed, false); // RPM exceeded

  // Check usage
  const usage = await limiter.getUsage('TEST_KEY');
  assert.equal(usage.verify_rpm, 2);
  assert.equal(usage.settle_rpm, 1);
  assert.equal(usage.fee_spd, 500);
});

test('rate limiter honors per-key overrides', async () => {
  const config = {
    global: { verifyRpm: 1, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 1000 },
    keys: {
      TEST_KEY: { verifyRpm: 5, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 1000 },
    },
  };
  const limiter = new RateLimiter(config);
  const req = { keyId: 'TEST_KEY' };

  await limiter.recordVerify(req);
  await limiter.recordVerify(req);
  assert.equal((await limiter.checkVerify(req)).allowed, true); // Since limit is 5
});

test('rate limiter halts on fee ceiling', async () => {
  // checkSettle reserves the worst-case max fee (50000 stroops by default)
  // against feeSpd before every settlement (Option B), so the ceiling must
  // sit just above the reservation to let the first checks through.
  const config = {
    global: { verifyRpm: 10, settleRpm: 10, settleRph: 10, settleRpd: 10, feeSpd: 50500 },
    keys: {},
  };
  const limiter = new RateLimiter(config);
  const req = { keyId: 'TEST_KEY' };

  assert.equal((await limiter.checkSettle(req)).allowed, true);
  await limiter.recordSettle(req, 400);
  assert.equal((await limiter.checkSettle(req)).allowed, true);

  // 400 + 200 = 600 consumed; 600 + 50000 reservation clears 50500.
  await limiter.recordSettle(req, 200);

  // Now consumed is 600. Next check should fail.
  const res = await limiter.checkSettle(req);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'fee_ceiling_exceeded');
});

test('rate limiter falls back to IP in open mode', async () => {
  const config = {
    global: { verifyRpm: 1, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 1000 },
    keys: {},
  };
  const limiter = new RateLimiter(config);
  const req1 = { ip: '192.168.1.1' };
  const req2 = { ip: '192.168.1.2' };

  assert.equal((await limiter.checkVerify(req1)).allowed, true);
  await limiter.recordVerify(req1);
  assert.equal((await limiter.checkVerify(req1)).allowed, false);

  // req2 should still be allowed since it's a different IP
  assert.equal((await limiter.checkVerify(req2)).allowed, true);
});

test('rate limiter sweeps expired buckets', async () => {
  const config = {
    global: {
      verifyRpm: 1,
      settleRpm: 1,
      settleRph: 10,
      settleRpd: 100,
      feeSpd: 1000,
      catalogRpm: 1,
    },
    keys: {},
  };
  const limiter = new RateLimiter(config);
  const now = Math.floor(Date.now() / 1000);

  // Directly inject an expired bucket
  limiter.store.map.set('catalog:127.0.0.1:60', { count: 5, resetAt: now - 10 });
  await limiter._sweep(now);
  assert.equal(limiter.store.map.has('catalog:127.0.0.1:60'), false);
});

test('stubRateLimiter matches the real limiter surface and return shapes', async () => {
  const real = new RateLimiter({
    global: {
      verifyRpm: 10,
      settleRpm: 10,
      settleRph: 10,
      settleRpd: 10,
      feeSpd: 500,
      catalogRpm: 10,
      catalogReadRpm: 10,
    },
    keys: {},
  });
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

test('real RateLimiter serves all payment and discovery routes', async () => {
  const rateLimiter = new RateLimiter({
    global: {
      verifyRpm: 10,
      settleRpm: 10,
      settleRph: 10,
      settleRpd: 10,
      feeSpd: 500000,
      catalogRpm: 10,
    },
    keys: {},
  });
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

test('catalog limiter enforces limits', async () => {
  const config = {
    global: {
      verifyRpm: 10,
      settleRpm: 10,
      settleRph: 10,
      settleRpd: 10,
      feeSpd: 500,
      catalogRpm: 2,
    },
    keys: {
      CUSTOM_KEY: { catalogRpm: 1 },
    },
  };
  const limiter = new RateLimiter(config);

  // Test global limit (2 RPM)
  const req1 = { ip: '127.0.0.1' };
  assert.equal((await limiter.checkCatalog(req1)).allowed, true);
  await limiter.recordCatalog(req1);
  assert.equal((await limiter.checkCatalog(req1)).allowed, true);
  await limiter.recordCatalog(req1);
  const res1 = await limiter.checkCatalog(req1);
  assert.equal(res1.allowed, false);
  assert.equal(res1.reason, 'catalog_rate_limited');

  // Test per-key limit (1 RPM)
  const req2 = { keyId: 'CUSTOM_KEY', ip: '127.0.0.1' };
  assert.equal((await limiter.checkCatalog(req2)).allowed, true);
  await limiter.recordCatalog(req2);
  const res2 = await limiter.checkCatalog(req2);
  assert.equal(res2.allowed, false);
  assert.equal(res2.reason, 'catalog_rate_limited');
});
