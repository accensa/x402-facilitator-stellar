/**
 * The central error boundary must not trust an arbitrary `statusCode` (#660).
 *
 * Every error that reaches the boundary is potentially thrown by a dependency
 * or a route far from it, and `err.statusCode` is just a property on an object.
 * The old selection mirrored any integer: a claim of 200 answered an error body
 * under HTTP 200 (a client reads it as success), and 999 or 42 answered a
 * status no HTTP client accepts. Only 400..599 is a client-visible error; every
 * other claim falls back to 500. The 400/413 transport mappings must still win.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, stubRateLimiter, testConfig, TEST_SECRET, VALID_BODY } from './helpers/app.js';

const auth = { authorization: `Bearer ${TEST_SECRET}` };

/**
 * Boots the app with a rate limiter whose `/usage` handler throws an error
 * carrying `statusCode`, then injects `GET /usage`. `/usage` has no route-level
 * catch, so the error reaches the central boundary — the surface under test.
 */
async function statusForClaim(statusCode) {
  const rateLimiter = stubRateLimiter();
  rateLimiter.getUsage = () => {
    throw Object.assign(new Error(`claimed ${statusCode}`), { statusCode });
  };
  const app = await serve({
    rateLimiter,
    config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }),
  });
  try {
    const res = await app.get('/usage', auth);
    return { status: res.status, body: await res.json() };
  } finally {
    await app.close();
  }
}

describe('a thrown error cannot dictate an invalid status (#660)', () => {
  test('a 200 claim is clamped to 500, not answered as success', async () => {
    const { status, body } = await statusForClaim(200);
    assert.equal(status, 500);
    assert.equal(body.error, 'internal_error');
  });

  test('a 999 claim is clamped to 500', async () => {
    const { status } = await statusForClaim(999);
    assert.equal(status, 500);
  });

  test('a 42 claim is clamped to 500', async () => {
    const { status } = await statusForClaim(42);
    assert.equal(status, 500);
  });

  test('a non-integer claim is clamped to 500', async () => {
    const { status } = await statusForClaim('404');
    assert.equal(status, 500);
  });

  test('in-range 4xx and 5xx claims are still propagated', async () => {
    const notFound = await statusForClaim(404);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error, 'internal_error');

    const unavailable = await statusForClaim(503);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error, 'internal_error');
  });
});

describe('the transport mappings still override the claim (#660)', () => {
  test('malformed JSON answers 400, whatever the parsed status would be', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', '{"paymentPayload": broken');
      assert.equal(res.status, 400);
      assert.equal((await res.json()).invalidReason, 'malformed_json');
    } finally {
      await app.close();
    }
  });

  test('an oversized body answers 413 and keeps its VERIFY shape', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
      assert.equal(res.status, 413);
      assert.equal((await res.json()).invalidReason, 'payload_too_large');
    } finally {
      await app.close();
    }
  });

  test('the /verify and /settle body shapes are unchanged by the clamp', async () => {
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkVerify = () => {
      throw Object.assign(new Error('limiter backend down'), { statusCode: 200 });
    };
    const app = await serve({ rateLimiter });
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'internal_error');
      assert.match(body.invalidMessage, /limiter backend down/);
    } finally {
      await app.close();
    }
  });
});
