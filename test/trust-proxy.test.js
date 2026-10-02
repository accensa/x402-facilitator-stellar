/**
 * Client IP resolution tests (issue #111).
 *
 * These exercise the real app over a real socket, because req.ip is decided by
 * Express's trust proxy machinery at connection time — not reachable through a
 * stub. The rate limiter is the observer: buckets keyed on req.ip are what a
 * wrong identity breaks first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { isCloudflareIp, resolveClientIp } from '../src/trust-proxy.js';
import {
  serve,
  withApp,
  testConfig,
  stubFacilitator,
  stubCatalog,
  stubRateLimiter,
  VALID_BODY,
} from './helpers/app.js';

function oneVerifyLimit() {
  return new RateLimiter({
    global: { verifyRpm: 1, settleRpm: 10, settleRph: 100, settleRpd: 1000, feeSpd: 1e9 },
    keys: {},
  });
}

test('forged X-Forwarded-For does not change the resolved IP when no proxy is trusted', async () => {
  const instance = await serve({
    config: { ...testConfig(), trustProxy: undefined },
    facilitator: stubFacilitator(),
    rateLimiter: oneVerifyLimit(),
    catalog: stubCatalog(),
  });
  try {
    // Two requests claiming two different client IPs. With trust proxy off,
    // both resolve to the socket address and share one bucket.
    const first = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    assert.ok(first.status !== 429, `first request should pass, got ${first.status}`);

    const second = await instance.post('/verify', VALID_BODY, {
      'x-forwarded-for': '198.51.100.9',
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).reason, 'rate_limit_exceeded');
  } finally {
    await instance.close();
  }
});

test('with a trusted proxy, different client IPs get different rate-limit buckets', async () => {
  const instance = await serve({
    config: { ...testConfig(), trustProxy: 1 },
    facilitator: stubFacilitator(),
    rateLimiter: oneVerifyLimit(),
    catalog: stubCatalog(),
  });
  try {
    const a1 = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    assert.ok(a1.status !== 429, `client A first request should pass, got ${a1.status}`);

    // A different client IP must land in its own bucket.
    const b1 = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '198.51.100.9' });
    assert.ok(b1.status !== 429, `client B should have an independent bucket, got ${b1.status}`);

    // ...and client A is now out of budget.
    const a2 = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    assert.equal(a2.status, 429);

    // Even a forged XFF beyond one trusted hop is not believed: with
    // TRUST_PROXY=1 only the immediate connection peer is trusted, so the
    // leftmost entry stays attacker-controlled noise.
    const forged = await instance.post('/verify', VALID_BODY, {
      'x-forwarded-for': '6.6.6.6, 203.0.113.7',
    });
    assert.equal(forged.status, 429);
  } finally {
    await instance.close();
  }
});

/**
 * A recording limiter plus the identity pseudonymizer, so a test can observe
 * the exact address req.ip resolved to (same pattern as app.test.js).
 */
function observeClientIp() {
  const seen = [];
  const rateLimiter = stubRateLimiter();
  rateLimiter.checkVerify = req => {
    seen.push(req.ip);
    return { allowed: true, limit: 60, remaining: 59, resetAt: 0 };
  };
  return { seen, extras: { ipPseudonymizer: ip => ip }, rateLimiter };
}

test('hop count 0 ignores X-Forwarded-For: every caller shares the peer bucket', async () => {
  const instance = await serve({
    config: { ...testConfig(), trustProxy: 0 },
    facilitator: stubFacilitator(),
    rateLimiter: oneVerifyLimit(),
    catalog: stubCatalog(),
  });
  try {
    const first = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    assert.ok(first.status !== 429, `first request should pass, got ${first.status}`);

    // A different claimed client IP must not buy a fresh bucket: with zero
    // trusted hops the socket peer is the only identity there is.
    const second = await instance.post('/verify', VALID_BODY, {
      'x-forwarded-for': '198.51.100.9',
    });
    assert.equal(second.status, 429);
  } finally {
    await instance.close();
  }
});

test('a hop count beyond the chain length fails closed to the peer, not to a forged entry', async () => {
  const { seen, extras, rateLimiter } = observeClientIp();

  // TRUST_PROXY=3 claims three trusted hops, but each header carries two
  // entries. Resolution must fail closed to the socket peer rather than
  // believe the client-written leftmost entry — otherwise the caller picks
  // their own rate-limit bucket.
  await withApp({ config: testConfig({ trustProxy: 3 }), rateLimiter, extras }, async app => {
    await app.post('/verify', VALID_BODY, { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
  });
  await withApp({ config: testConfig({ trustProxy: 3 }), rateLimiter, extras }, async app => {
    await app.post('/verify', VALID_BODY, { 'x-forwarded-for': '8.8.8.8, 198.51.100.9' });
  });

  assert.deepEqual(seen, ['127.0.0.1', '127.0.0.1']);
});

test('a two-proxy chain resolves the leftmost entry when both hops are trusted', async () => {
  const { seen, extras, rateLimiter } = observeClientIp();

  // client (203.0.113.7) → proxy1 (198.51.100.9) → proxy2 (the peer) → us.
  // TRUST_PROXY=2 trusts the peer and the rightmost XFF entry, so the client
  // IP is the entry immediately left of that boundary.
  await withApp({ config: testConfig({ trustProxy: 2 }), rateLimiter, extras }, async app => {
    await app.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7, 198.51.100.9' });
  });

  assert.deepEqual(seen, ['203.0.113.7']);
});

test('a proxy list resolves the first untrusted entry from the right', async () => {
  const { seen, extras, rateLimiter } = observeClientIp();

  // The test server listens on 127.0.0.1, so the list must trust loopback
  // for the header to be consulted at all.
  await withApp(
    { config: testConfig({ trustProxy: ['loopback'] }), rateLimiter, extras },
    async app => {
      // The peer appended the rightmost entry — the caller as the trusted
      // proxy saw it.
      await app.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7, 198.51.100.9' });

      // A forged chain: the attacker's real address is still the rightmost
      // entry, so the leftmost forgery is never reached.
      await app.post('/verify', VALID_BODY, { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
    },
  );

  assert.deepEqual(seen, ['198.51.100.9', '203.0.113.7']);
});

test('a proxy list matches the peer by CIDR, not only by exact address', async () => {
  const { seen, extras, rateLimiter } = observeClientIp();

  await withApp(
    { config: testConfig({ trustProxy: ['127.0.0.0/8'] }), rateLimiter, extras },
    async app => {
      await app.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    },
  );

  assert.deepEqual(seen, ['203.0.113.7']);
});

test('a proxy list with an untrusted peer discards X-Forwarded-For outright', async () => {
  const instance = await serve({
    config: { ...testConfig(), trustProxy: ['10.0.0.5'] },
    facilitator: stubFacilitator(),
    rateLimiter: oneVerifyLimit(),
    catalog: stubCatalog(),
  });
  try {
    // The peer is 127.0.0.1, which the list does not trust, so the header
    // is noise: both callers resolve to the peer and share one bucket.
    const first = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    assert.ok(first.status !== 429, `first request should pass, got ${first.status}`);

    const second = await instance.post('/verify', VALID_BODY, {
      'x-forwarded-for': '198.51.100.9',
    });
    assert.equal(second.status, 429);
  } finally {
    await instance.close();
  }
});

test('CF-Connecting-IP is honored only when the TCP peer is a Cloudflare address', () => {
  const cfPeer = '103.21.244.1';
  const plainPeer = '127.0.0.1';

  // From a Cloudflare edge, the edge's own header is the client IP.
  assert.equal(
    resolveClientIp({
      socket: { remoteAddress: cfPeer },
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    }),
    '203.0.113.7',
  );

  // ...including over a disagreeing X-Forwarded-For.
  assert.equal(
    resolveClientIp({
      socket: { remoteAddress: cfPeer },
      headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6, 198.51.100.9' },
    }),
    '203.0.113.7',
  );

  // An IPv6 Cloudflare peer is recognized too.
  assert.equal(
    resolveClientIp({
      socket: { remoteAddress: '2606:4700::1' },
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    }),
    '203.0.113.7',
  );

  // An IPv4 connection arriving on a dual-stack socket reports as
  // ::ffff:a.b.c.d — still a Cloudflare peer.
  assert.equal(
    resolveClientIp({
      socket: { remoteAddress: '::ffff:103.21.244.1' },
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    }),
    '203.0.113.7',
  );

  // From any other peer the header is client-writable noise and is ignored.
  assert.equal(
    resolveClientIp({
      socket: { remoteAddress: plainPeer },
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    }),
    plainPeer,
  );

  // A malformed CF-Connecting-IP is discarded, not believed.
  assert.equal(
    resolveClientIp({
      socket: { remoteAddress: cfPeer },
      headers: { 'cf-connecting-ip': 'not-an-ip' },
    }),
    cfPeer,
  );
});

test('isCloudflareIp matches the published ranges and nothing else', () => {
  assert.equal(isCloudflareIp('103.21.244.1'), true);
  assert.equal(isCloudflareIp('172.64.0.1'), true);
  assert.equal(isCloudflareIp('2606:4700::1'), true);
  assert.equal(isCloudflareIp('::ffff:103.21.244.1'), true);
  assert.equal(isCloudflareIp('203.0.113.7'), false);
  assert.equal(isCloudflareIp('127.0.0.1'), false);
  assert.equal(isCloudflareIp('not-an-ip'), false);
  assert.equal(isCloudflareIp(undefined), false);
});
