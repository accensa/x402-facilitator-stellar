/**
 * JWT JWKS single-flight test for issue #679.
 * Verifies that concurrent cold JWT requests each build a new JWKS set
 * and that only one fetch is produced per JWKS URI.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createJwtVerifier } from '../src/auth-http.js';

const TEST_JWKS_URI = 'https://example.com/.well-known/jwts';

describe('JWKS single-flight', () => {
  test('with a cold cache, 10 concurrent verifyToken calls produce exactly one fetch', async _t => {
    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, _init) => {
      fetchCallCount++;
      // Return a minimal JWKS response
      const body = JSON.stringify({
        keys: [{ kty: 'OKP', crv: 'Ed25519', kid: '1', alg: 'EdDSA' }],
      });
      return new Response(body, { status: 200 });
    };

    try {
      const fastify = Fastify();

      const jwtVerifier = createJwtVerifier(TEST_JWKS_URI);

      fastify.get('/verify', {
        handler: async (req, reply) => {
          const authHeader = req.headers.authorization;
          if (!authHeader) {
            return reply.code(401).send({ isValid: false });
          }
          try {
            await jwtVerifier.verifyToken(authHeader.replace('Bearer ', ''));
            reply.send({ valid: true });
          } catch (err) {
            reply.code(401).send({ isValid: false, reason: err.message });
          }
        },
        onRequest: [],
      });

      await fastify.ready();

      // Fire 10 concurrent requests with cold JWKS cache
      fetchCallCount = 0;
      const requests = Array(10)
        .fill()
        .map(_ =>
          fastify.inject({
            method: 'GET',
            url: '/verify',
            headers: {
              Authorization: 'Bearer some-fake-jwt-token',
            },
          }),
        );

      const responses = await Promise.all(requests);

      // Exactly one fetch should have been made
      assert.strictEqual(fetchCallCount, 1, `Expected 1 fetch, got ${fetchCallCount}`);

      // All requests should have been processed
      for (const resp of responses) {
        assert.ok(resp.statusCode === 200 || resp.statusCode === 401);
      }

      await fastify.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a failed construction leaves no permanently rejected promise: the next call retries', async _t => {
    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    let shouldFail = true;
    globalThis.fetch = async (_input, _init) => {
      fetchCallCount++;
      if (shouldFail) {
        shouldFail = false;
        throw new Error('JWKS server unreachable');
      }
      const body = JSON.stringify({ keys: [] });
      return new Response(body, { status: 200 });
    };

    try {
      const fastify = Fastify();

      const jwtVerifier = createJwtVerifier(TEST_JWKS_URI);

      fastify.get('/verify', {
        handler: async (req, reply) => {
          const authHeader = req.headers.authorization;
          if (!authHeader) {
            return reply.code(401).send({ isValid: false });
          }
          try {
            await jwtVerifier.verifyToken(authHeader.replace('Bearer ', ''));
            reply.send({ valid: true });
          } catch (err) {
            reply.code(401).send({ isValid: false, reason: err.message });
          }
        },
        onRequest: [],
      });

      await fastify.ready();

      // First call: should fail
      const _firstResp = await fastify.inject({
        method: 'GET',
        url: '/verify',
        headers: {
          Authorization: 'Bearer some-fake-jwt-token',
        },
      });

      // Second call: should retry and succeed (the in-flight entry was cleared on failure)
      const secondResp = await fastify.inject({
        method: 'GET',
        url: '/verify',
        headers: {
          Authorization: 'Bearer some-fake-jwt-token',
        },
      });

      // Should have made 2 fetches: 1 initial + 1 retry
      assert.strictEqual(fetchCallCount, 2, `Expected 2 fetches (1 retry), got ${fetchCallCount}`);
      assert.strictEqual(secondResp.statusCode, 200, 'Second call should succeed after retry');

      await fastify.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
