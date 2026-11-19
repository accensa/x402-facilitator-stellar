import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createJwtVerifier } from '../src/auth-http.js';

async function startJwksServer({ failRequests = 0 } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';

  let requestCount = 0;
  let remainingFailures = failRequests;
  const server = Fastify();
  server.get('/jwks', async (_req, reply) => {
    requestCount++;
    if (remainingFailures > 0) {
      remainingFailures--;
      return reply.code(503).send({ error: 'temporary JWKS failure' });
    }
    return reply.send({ keys: [publicJwk] });
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();

  const token = await new SignJWT({ scope: 'read' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuer('test-issuer')
    .setAudience('test-audience')
    .setSubject('test-user')
    .setExpirationTime('5m')
    .sign(privateKey);

  return {
    server,
    token,
    uri: `http://127.0.0.1:${address.port}/jwks`,
    getRequestCount: () => requestCount,
  };
}

describe('JWKS single-flight', () => {
  test('a cold cache serves concurrent verifications with one JWKS request', async () => {
    const jwks = await startJwksServer();
    try {
      const verifier = createJwtVerifier(jwks.uri, {
        issuer: 'test-issuer',
        audience: 'test-audience',
      });

      const payloads = await Promise.all(
        Array.from({ length: 10 }, () => verifier.verifyToken(jwks.token)),
      );

      assert.equal(payloads.length, 10);
      assert.equal(jwks.getRequestCount(), 1);
    } finally {
      await jwks.server.close();
    }
  });

  test('a failed JWKS request is cleared so the next call retries', async () => {
    const jwks = await startJwksServer({ failRequests: 1 });
    try {
      const verifier = createJwtVerifier(jwks.uri, {
        issuer: 'test-issuer',
        audience: 'test-audience',
      });

      await assert.rejects(() => verifier.verifyToken(jwks.token));
      const payload = await verifier.verifyToken(jwks.token);

      assert.equal(payload.sub, 'test-user');
      assert.equal(jwks.getRequestCount(), 2);
    } finally {
      await jwks.server.close();
    }
  });
});
