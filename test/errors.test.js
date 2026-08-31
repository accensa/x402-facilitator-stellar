/**
 * The central error boundary and 404 handler (#78).
 *
 * What is under test is the promise the app header makes: every rejection
 * carries a non-null reason code, including transport-level ones, and no
 * response ever carries a stack trace — even with NODE_ENV unset, which is how
 * the Docker image runs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, stubRateLimiter, stubFacilitator, testConfig, VALID_BODY } from './helpers/app.js';

describe('404', () => {
  test('unknown routes get JSON with a reason code, not HTML', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verifyy', {});
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = await res.json();
      assert.ok(body.reason);
      assert.equal(body.error, 'not_found');
    } finally {
      await app.close();
    }
  });
});

describe('malformed JSON on /verify', () => {
  test('returns JSON with the malformed_json reason, not HTML', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', '{"paymentPayload": broken');
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = await res.json();
      assert.equal(body.isValid, false);
      // #143: Fastify 5 names the parser error FST_ERR_CTP_INVALID_JSON_BODY.
      // It used to fall through to `internal_error`; the wire reason is
      // contract and must stay `malformed_json`.
      assert.equal(body.invalidReason, 'malformed_json');
      assert.ok(!/at\s+\S+:\d+/.test(JSON.stringify(body)), 'must not carry a stack trace');
    } finally {
      await app.close();
    }
  });
});

describe('oversized body', () => {
  test('a body over the 256kb cap returns JSON with a reason code', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
      assert.equal(res.status, 413);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = await res.json();
      assert.ok(body.invalidReason);
    } finally {
      await app.close();
    }
  });
});

describe('errors that escape the route-level catches', () => {
  test('/verify keeps its shape even when the boundary handles it', async () => {
    // checkVerify throws above the route's own try block, so this reaches the
    // central handler — which must still answer in the verify shape.
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkVerify = () => {
      throw new Error('limiter backend down');
    };
    const app = await serve({ rateLimiter });
    try {
      const res = await app.post('/verify', VALID_BODY);
      const body = await res.json();
      assert.equal(body.isValid, false);
      assert.ok(body.invalidReason);
      assert.ok(body.invalidMessage.includes('limiter backend down'));
      assert.ok(!JSON.stringify(body).includes('at '), 'must not carry a stack trace');
    } finally {
      await app.close();
    }
  });

  test('/settle errors still carry transaction and network', async () => {
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkSettle = () => {
      throw new Error('limiter backend down');
    };
    const app = await serve({ rateLimiter });
    try {
      const res = await app.post('/settle', VALID_BODY);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.ok(body.errorReason);
      assert.equal(body.transaction, '');
      assert.equal(body.network, VALID_BODY.paymentRequirements.network);
    } finally {
      await app.close();
    }
  });

  test('other routes get a generic JSON error without a stack trace', async () => {
    // NODE_ENV is unset throughout these tests, matching the Docker image.
    delete process.env.NODE_ENV;
    // getUsage throws outside any route-level try, so this reaches the central
    // boundary rather than a route's own catch.
    const rateLimiter = stubRateLimiter();
    rateLimiter.getUsage = () => {
      throw new Error('metering exploded');
    };
    const app = await serve({
      rateLimiter,
      config: testConfig({ apiKeys: ['test:secret'] }),
    });
    try {
      const res = await app.get('/usage', { authorization: 'Bearer secret' });
      assert.equal(res.status, 500);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = await res.json();
      assert.equal(body.error, 'internal_error');
      assert.ok(body.reason);
      assert.ok(!/at\s/.test(JSON.stringify(body)));
    } finally {
      await app.close();
    }
  });
});

describe('route-level catch behaviour is unchanged', () => {
  test('/verify still answers 200 with isValid: false on a scheme error', async () => {
    const facilitator = stubFacilitator({
      verify: async () => {
        throw new Error('scheme exploded');
      },
    });
    const app = await serve({ facilitator });
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).invalidReason, 'facilitator_error');
    } finally {
      await app.close();
    }
  });

  test('/settle still answers 200 with success: false on a scheme error', async () => {
    const facilitator = stubFacilitator({
      settle: async () => {
        throw new Error('scheme exploded');
      },
    });
    const app = await serve({ facilitator });
    try {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).errorReason, 'facilitator_error');
    } finally {
      await app.close();
    }
  });
});
