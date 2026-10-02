/**
 * @file test/app-modular-helpers.test.js
 * @description Unit tests for the modular helper components extracted from src/app.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EXPOSED_HEADERS, createCorsHook, createPreflightHandler } from '../src/cors.js';
import { verifyApiKey, createAuthMiddleware } from '../src/auth.js';
import { handleRateLimit, rejectRateLimited } from '../src/rate-limit-http.js';
import {
  canonicalizeDiscoveryParams,
  discoveryETag,
  applyDiscoveryCache,
} from '../src/catalog/discovery-cache.js';
import {
  PAYMENT_BODY_SCHEMA,
  BODY_LIMIT_BYTES,
  readPaymentBody,
  readDiscoveryBody,
} from '../src/payment-body.js';
import { annotateSpan, withRequestSpan, tracedSchemeCall } from '../src/tracing.js';

describe('src/cors.js', () => {
  test('EXPOSED_HEADERS contains all required headers', () => {
    assert.ok(EXPOSED_HEADERS.includes('RateLimit-Limit'));
    assert.ok(EXPOSED_HEADERS.includes('RateLimit-Remaining'));
    assert.ok(EXPOSED_HEADERS.includes('RateLimit-Reset'));
    assert.ok(EXPOSED_HEADERS.includes('Retry-After'));
    assert.ok(EXPOSED_HEADERS.includes('EXTENSION-RESPONSES'));
  });

  test('createCorsHook grants wildcard for public policy when no origins configured', async () => {
    const cors = createCorsHook({ allowedOrigins: [] });
    const hook = cors('public');
    const headers = {};
    const reply = {
      header: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
    };
    await hook({ headers: { origin: 'https://example.com' } }, reply);
    assert.equal(headers['access-control-allow-origin'], '*');
    assert.equal(headers['vary'], 'Origin');
  });

  test('createCorsHook denies unlisted origin for authenticated policy', async () => {
    const cors = createCorsHook({ allowedOrigins: ['https://trusted.com'] });
    const hook = cors('authenticated');
    const headers = {};
    const reply = {
      header: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
    };
    await hook({ headers: { origin: 'https://untrusted.com' } }, reply);
    assert.equal(headers['access-control-allow-origin'], undefined);
  });

  test('createPreflightHandler returns 204 with methods and headers', async () => {
    const preflight = createPreflightHandler({ allowedOrigins: ['https://trusted.com'] });
    const handler = preflight('public');
    const headers = {};
    let statusCode = null;
    const reply = {
      header: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      code: c => {
        statusCode = c;
        return reply;
      },
      send: () => ({ status: statusCode, headers }),
    };
    await handler({ headers: { origin: 'https://trusted.com' } }, reply);
    assert.equal(statusCode, 204);
    assert.equal(headers['access-control-allow-origin'], 'https://trusted.com');
    assert.equal(headers['access-control-allow-methods'], 'GET, OPTIONS');
    assert.ok(headers['access-control-allow-headers'].includes('Authorization'));
  });
});

describe('src/auth.js', () => {
  const secretKey = 'mysecret';
  const secretHash = createHash('sha256').update(secretKey).digest();
  const apiKeys = [{ id: 'admin', hash: secretHash }];

  test('verifyApiKey succeeds with Bearer prefix', () => {
    const res = verifyApiKey(`Bearer ${secretKey}`, apiKeys);
    assert.equal(res.valid, true);
    assert.equal(res.keyId, 'admin');
  });

  test('verifyApiKey succeeds with plain raw secret', () => {
    const res = verifyApiKey(secretKey, apiKeys);
    assert.equal(res.valid, true);
    assert.equal(res.keyId, 'admin');
  });

  test('verifyApiKey rejects missing header', () => {
    const res = verifyApiKey(undefined, apiKeys);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'missing_auth_header');
  });

  test('verifyApiKey rejects malformed header', () => {
    assert.equal(verifyApiKey('Bearer ', apiKeys).reason, 'malformed_auth_header');
    assert.equal(verifyApiKey('Bearer token extra', apiKeys).reason, 'malformed_auth_header');
  });

  test('verifyApiKey rejects invalid key', () => {
    const res = verifyApiKey('wrongsecret', apiKeys);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'invalid_api_key');
  });

  test('createAuthMiddleware sets req.keyId to uppercase on success', async () => {
    const auditLogs = [];
    const audit = (ev, data) => auditLogs.push({ ev, data });
    const { requireApiKey } = createAuthMiddleware({
      config: { apiKeys },
      audit,
    });
    const req = {
      headers: { authorization: `Bearer ${secretKey}` },
      ip: '127.0.0.1',
      span: {},
    };
    const reply = {};
    await requireApiKey(req, reply);
    assert.equal(req.keyId, 'ADMIN');
    assert.equal(req.span.keyId, 'admin');
    assert.equal(auditLogs.length, 0);
  });

  test('createAuthMiddleware strict mode forbids open mode with 401', async () => {
    const { requireApiKeyStrict } = createAuthMiddleware({
      config: { apiKeys: [] },
      audit: () => {},
    });
    const req = { headers: {} };
    let code = null;
    let body = null;
    const reply = {
      code: c => {
        code = c;
        return reply;
      },
      send: b => {
        body = b;
      },
    };
    await requireApiKeyStrict(req, reply);
    assert.equal(code, 401);
    assert.equal(body.invalidReason, 'open_mode_usage_forbidden');
  });
});

describe('src/rate-limit-http.js', () => {
  test('handleRateLimit sets rate limit headers on allowed request', () => {
    const headers = {};
    const reply = {
      header: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
    };
    const res = handleRateLimit(reply, {
      limit: 100,
      remaining: 99,
      resetAt: 1234567890,
      allowed: true,
    });
    assert.equal(res, null);
    assert.equal(headers['ratelimit-limit'], 100);
    assert.equal(headers['ratelimit-remaining'], 99);
    assert.equal(headers['ratelimit-reset'], 1234567890);
  });

  test('handleRateLimit emits 429 when not allowed', () => {
    const headers = {};
    let statusCode = null;
    let payload = null;
    const reply = {
      header: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      code: c => {
        statusCode = c;
        return reply;
      },
      send: b => {
        payload = b;
        return payload;
      },
    };
    const res = handleRateLimit(reply, {
      limit: 10,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 30,
      allowed: false,
      reason: 'rate_limit_exceeded',
    });
    assert.ok(res !== null);
    assert.equal(statusCode, 429);
    assert.equal(payload.invalidReason, 'rate_limited');
    assert.equal(payload.reason, 'rate_limit_exceeded');
  });

  test('rejectRateLimited audits rejection and returns 429', () => {
    const auditEvents = [];
    const headers = {};
    let statusCode = null;
    const reply = {
      header: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      code: c => {
        statusCode = c;
        return reply;
      },
      send: b => b,
    };
    const req = { keyId: 'KEY1', ip: '1.2.3.4' };
    rejectRateLimited(
      req,
      reply,
      '/verify',
      { limit: 10, remaining: 0, resetAt: 100, allowed: false, reason: 'exceeded' },
      (ev, data) => auditEvents.push({ ev, data }),
    );
    assert.equal(statusCode, 429);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].ev, 'rate_limit_rejected');
    assert.equal(auditEvents[0].data.actor, 'KEY1');
  });

  test('handleRateLimit uses recorded state over fallback check state', () => {
    const headers = {};
    const reply = {
      header: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
    };
    handleRateLimit(
      reply,
      { limit: 100, remaining: 80, resetAt: 200, allowed: true },
      { limit: 100, remaining: 81, resetAt: 200, allowed: true },
    );
    assert.equal(headers['ratelimit-remaining'], 80);
  });
});

describe('src/catalog/discovery-cache.js', () => {
  test('canonicalizeDiscoveryParams produces stable deterministic json', () => {
    const p1 = { b: '2', a: '1', tags: ['z', 'a'] };
    const p2 = { tags: ['a', 'z'], a: '1', b: '2' };
    assert.equal(canonicalizeDiscoveryParams(p1), canonicalizeDiscoveryParams(p2));
  });

  test('discoveryETag generates weak ETag incorporating catalog version', () => {
    const etag1 = discoveryETag(1, { query: 'test' });
    const etag2 = discoveryETag(2, { query: 'test' });
    assert.match(etag1, /^W\/"1-[A-Za-z0-9_-]+"$/);
    assert.match(etag2, /^W\/"2-[A-Za-z0-9_-]+"$/);
    assert.notEqual(etag1, etag2);
  });

  test('applyDiscoveryCache detects matching If-None-Match header', () => {
    const headers = {};
    const reply = {
      header: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
    };
    const catalog = { getVersion: () => 5, getLastModified: () => 1700000000000 };
    const params = { query: 'stellar' };
    const etag = discoveryETag(5, params);

    const req = { headers: { 'if-none-match': etag } };
    const result = applyDiscoveryCache(req, reply, catalog, undefined, params);
    assert.equal(result.notModified, true);
    assert.equal(headers['etag'], etag);
    assert.ok(headers['cache-control']);
    assert.ok(headers['last-modified']);
  });
});

describe('src/payment-body.js', () => {
  test('BODY_LIMIT_BYTES is 256KB', () => {
    assert.equal(BODY_LIMIT_BYTES, 256 * 1024);
  });

  test('PAYMENT_BODY_SCHEMA requires paymentPayload and paymentRequirements', () => {
    assert.deepEqual(PAYMENT_BODY_SCHEMA.required, ['paymentPayload', 'paymentRequirements']);
  });

  test('readPaymentBody extracts valid payload and requirements', () => {
    const validBody = {
      paymentPayload: { transaction: 'xdr' },
      paymentRequirements: { scheme: 'exact', network: 'stellar:testnet' },
    };
    const config = { networks: ['stellar:testnet'] };
    const req = { body: validBody };
    const reply = {};
    const res = readPaymentBody(req, reply, config, 'verify');
    assert.ok(res !== null);
    assert.deepEqual(res.paymentPayload, validBody.paymentPayload);
    assert.deepEqual(res.paymentRequirements, validBody.paymentRequirements);
  });

  test('readPaymentBody shapes settle error on validation failure', () => {
    const invalidBody = {
      paymentPayload: {},
      paymentRequirements: { scheme: 'exact', network: 'unknown:net' },
    };
    const config = { networks: ['stellar:testnet'] };
    const req = { body: invalidBody };
    let code = null;
    let body = null;
    const reply = {
      code: c => {
        code = c;
        return reply;
      },
      send: b => {
        body = b;
      },
    };
    const res = readPaymentBody(req, reply, config, 'settle');
    assert.equal(res, null);
    assert.equal(code, 400);
    assert.equal(body.success, false);
    assert.equal(body.errorReason, 'unsupported_network');
  });

  test('readDiscoveryBody validates discovery resource payload', () => {
    const validBody = {
      paymentPayload: {
        resource: { url: 'https://api.example.com', serviceName: 'test' },
      },
      paymentRequirements: { scheme: 'exact', network: 'stellar:testnet' },
    };
    const req = { body: validBody };
    const reply = {};
    const res = readDiscoveryBody(req, reply);
    assert.ok(res !== null);
    assert.deepEqual(res.paymentPayload, validBody.paymentPayload);
  });
});

describe('src/tracing.js helpers', () => {
  test('annotateSpan does not throw when no active span', () => {
    assert.doesNotThrow(() => {
      annotateSpan({ 'test.key': 'val' });
    });
  });

  test('withRequestSpan executes async callback', async () => {
    const req = {
      method: 'GET',
      headers: {},
      routeOptions: { url: '/test' },
    };
    const result = await withRequestSpan('test-span', req, async span => {
      assert.ok(span);
      return 42;
    });
    assert.equal(result, 42);
  });

  test('tracedSchemeCall runs scheme operation', async () => {
    const result = await tracedSchemeCall('verify', 'stellar:testnet', async () => {
      return { isValid: true, transaction: 'tx_123' };
    });
    assert.equal(result.isValid, true);
    assert.equal(result.transaction, 'tx_123');
  });
});
