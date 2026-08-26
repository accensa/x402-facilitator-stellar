import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, testConfig, stubFacilitator, stubRateLimiter, VALID_BODY } from './helpers/app.js';
import { LOCAL_REASONS, UPSTREAM_REASONS } from '../src/reasons.js';

const ALL_VALID_REASONS = new Set([
  ...Object.keys(LOCAL_REASONS),
  ...Object.keys(UPSTREAM_REASONS),
]);

function assertValidReason(reason) {
  assert.ok(reason, 'Reason must not be null or undefined');
  assert.ok(
    ALL_VALID_REASONS.has(reason),
    `Emitted reason "${reason}" is not a member of the exported enums in src/reasons.js`
  );
}

describe('Exhaustive Rejection Reason Taxonomy', () => {
  let app;
  let authApp;

  before(async () => {
    app = await serve();
    authApp = await serve({ config: testConfig({ apiKeys: ['admin:s3cret'] }) });
  });

  after(() => {
    app.close();
    authApp.close();
  });

  test('Missing Auth Header', async () => {
    const res = await authApp.post('/verify', VALID_BODY);
    const json = await res.json();
    assertValidReason(json.invalidReason);
    assert.equal(json.invalidReason, 'missing_auth_header');
  });

  test('Malformed Auth Header', async () => {
    const res = await authApp.post('/verify', VALID_BODY, {
      authorization: 'Bearer ',
    });
    const json = await res.json();
    assertValidReason(json.invalidReason);
    assert.equal(json.invalidReason, 'malformed_auth_header');
  });

  test('Invalid API Key', async () => {
    const res = await authApp.post('/verify', VALID_BODY, {
      authorization: 'Bearer wrongkey',
    });
    const json = await res.json();
    assertValidReason(json.invalidReason);
    assert.equal(json.invalidReason, 'invalid_api_key');
  });

  test('Open Mode Usage Forbidden', async () => {
    const res = await app.get('/usage');
    const json = await res.json();
    assertValidReason(json.invalidReason);
    assert.equal(json.invalidReason, 'open_mode_usage_forbidden');
  });

  test('Malformed Body (invalid_request)', async () => {
    const res = await app.post('/verify', {});
    const json = await res.json();
    assertValidReason(json.invalidReason);
    assert.equal(json.invalidReason, 'invalid_request');
  });

  test('Rate Limited', async () => {
    const limitedApp = await serve({ rateLimiter: stubRateLimiter({ allow: false }) });
    try {
      const res = await limitedApp.post('/verify', VALID_BODY);
      const json = await res.json();
      assertValidReason(json.invalidReason);
      assert.equal(json.invalidReason, 'rate_limited');
    } finally {
      await limitedApp.close();
    }
  });

  test('Facilitator Error', async () => {
    const errorApp = await serve({
      facilitator: stubFacilitator({
        verify: async () => {
          throw new Error('Some internal explosion');
        }
      })
    });
    try {
      const res = await errorApp.post('/verify', VALID_BODY);
      const json = await res.json();
      assertValidReason(json.invalidReason);
      assert.equal(json.invalidReason, 'facilitator_error');
    } finally {
      await errorApp.close();
    }
  });

  test('Soroban RPC Unreachable', async () => {
    const rpcErrorApp = await serve({
      facilitator: stubFacilitator({
        verify: async () => {
          const err = new Error('breaker');
          err.code = 'RPC_BREAKER_OPEN';
          throw err;
        }
      })
    });
    try {
      const res = await rpcErrorApp.post('/verify', VALID_BODY);
      const json = await res.json();
      assertValidReason(json.invalidReason);
      assert.equal(json.invalidReason, 'soroban_rpc_unreachable');
    } finally {
      await rpcErrorApp.close();
    }
  });

  test('Lock Timeout', async () => {
    const lockError = new Error('Timeout');
    lockError.name = 'LockAcquireTimeoutError';
    
    // Lock logic is inside settle
    const lockApp = await serve({
      distributedLock: {
        withLock: async () => {
          throw lockError;
        },
        quit: async () => {}
      }
    });
    try {
      const res = await lockApp.post('/settle', VALID_BODY);
      const json = await res.json();
      // Settle response uses errorReason
      assertValidReason(json.errorReason);
      assert.equal(json.errorReason, 'lock_timeout');
    } finally {
      await lockApp.close();
    }
  });

  test('Upstream Scheme Rejection Passthrough', async () => {
    const upstreamApp = await serve({
      facilitator: stubFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'invalid_exact_stellar_payload_authorization_not_signed',
          invalidMessage: 'payer signature missing',
        }),
      }),
    });
    try {
      const res = await upstreamApp.post('/verify', VALID_BODY);
      const json = await res.json();
      assertValidReason(json.invalidReason);
      assert.equal(json.invalidReason, 'invalid_exact_stellar_payload_authorization_not_signed');
    } finally {
      await upstreamApp.close();
    }
  });
});
