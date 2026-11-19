/**
 * JWT Bearer dispatch against a configured dotted API key (#658).
 *
 * A configured API key whose secret contains a dot used to be routed into the
 * JWT verifier by the `token.includes('.')` dispatch, so the timing-safe API
 * key comparison never ran and a valid key was answered 401. The verifier
 * failure must fall back to the key comparison before rejecting the caller.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { serve, testConfig, VALID_BODY } from './helpers/app.js';

const DOTTED_KEY = 's3cret.dotted.key.0123456789abcdefghijklmnop';
const UNCONFIGURED_DOTTED_KEY = 'other.dotted.key.9876543210abcdefghijklmnop';
const JWT_ISSUER = 'https://auth.example.com';
const JWT_AUDIENCE = 'x402-facilitator';

function authConfig(apiKeys, jwt) {
  return { ...testConfig({ apiKeys }), jwt };
}

async function startJwksServer() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  const privateJwk = keys.privateKey.export({ format: 'jwk' });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const jwksUri = `http://127.0.0.1:${server.address().port}/jwks.json`;
  const token = await new SignJWT({
    sub: 'admin',
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    scp: ['settle'],
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateJwk);
  return { server, jwksUri, token };
}

describe('JWT Bearer dispatch with a dotted configured key (#658)', () => {
  test('a configured API key containing a dot authenticates once a JWT verifier is present', async () => {
    const app = await serve({
      config: authConfig([`admin:${DOTTED_KEY}`], { jwksUri: 'http://127.0.0.1:1/jwks.json' }),
    });
    try {
      const res = await app.post('/verify', VALID_BODY, { authorization: `Bearer ${DOTTED_KEY}` });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { isValid: true });
    } finally {
      await app.close();
    }
  });

  test('a genuine JWT still verifies with its keyId and required scopes', async () => {
    const { server, jwksUri, token } = await startJwksServer();
    const app = await serve({
      config: authConfig([], {
        jwksUri,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        requiredScopes: ['settle'],
      }),
    });
    try {
      const res = await app.get('/usage', { authorization: `Bearer ${token}` });
      assert.equal(res.status, 200);
      const usage = await res.json();
      assert.equal(usage.keyId, 'ADMIN');
    } finally {
      await app.close();
      await new Promise(resolve => server.close(() => resolve()));
    }
  });

  test('an unconfigured dotted secret is still rejected with 401', async () => {
    const app = await serve({
      config: authConfig([`admin:${DOTTED_KEY}`], { jwksUri: 'http://127.0.0.1:1/jwks.json' }),
    });
    try {
      const res = await app.post('/verify', VALID_BODY, {
        authorization: `Bearer ${UNCONFIGURED_DOTTED_KEY}`,
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'invalid_api_key');
    } finally {
      await app.close();
    }
  });
});
