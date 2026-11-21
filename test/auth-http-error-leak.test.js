/**
 * Issue #666 - JWT verification errors must not echo diagnostic jose text or JWKS info to callers.
 *
 * Diagnostic error text from jose (such as "jwt expired", issuer/audience mismatches,
 * and JWKS fetch errors) must be mapped to stable codes (token_expired, insufficient_scope,
 * invalid_token) and logged server-side, never returned to the unauthenticated caller.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { serve, testConfig, VALID_BODY } from './helpers/app.js';

const JWT_ISSUER = 'https://auth.example.com';
const JWT_AUDIENCE = 'x402-facilitator';
const API_KEY = 'admin:testsecret-0123456789abcdefghijklmnopqrstuvwxyz';

async function setupJwks() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key-1';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const jwksUri = `http://127.0.0.1:${server.address().port}/jwks.json`;

  async function createToken({
    exp = '5m',
    scopes = ['settle'],
    issuer = JWT_ISSUER,
    audience = JWT_AUDIENCE,
    key = privateKey,
  } = {}) {
    let jwt = new SignJWT({
      sub: 'admin-user',
      iss: issuer,
      aud: audience,
      scp: scopes,
    }).setProtectedHeader({ alg: 'EdDSA', kid: 'test-key-1' });

    if (exp) {
      jwt = jwt.setExpirationTime(exp);
    }
    return jwt.sign(key);
  }

  return { server, jwksUri, createToken, privateKey };
}

describe('JWT error message redaction (#666)', () => {
  test('expired-token body carries token_expired with no jose text or JWKS URL', async () => {
    const { server, jwksUri, createToken } = await setupJwks();
    const expiredToken = await createToken({ exp: '-60s' });

    const serverLogs = [];
    const origError = console.error;
    console.error = (...args) => serverLogs.push(args.join(' '));

    const app = await serve({
      config: {
        ...testConfig({ apiKeys: [] }),
        jwt: {
          jwksUri,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          requiredScopes: ['settle'],
        },
      },
    });

    try {
      const res = await app.post('/verify', VALID_BODY, {
        authorization: `Bearer ${expiredToken}`,
      });

      assert.equal(res.status, 401);
      const rawText = await res.text();
      const body = JSON.parse(rawText);

      // Status and 4 fields preserved with mapped code
      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'token_expired');
      assert.equal(body.invalidMessage, 'unauthorized');
      assert.equal(body.reason, 'token_expired');

      // The jose string no longer reaches the wire
      assert.doesNotMatch(rawText, /ERR_JWT_EXPIRED/);
      assert.doesNotMatch(rawText, /jwt expired/);
      assert.doesNotMatch(rawText, /"exp" claim timestamp check failed/);
      assert.doesNotMatch(rawText, new RegExp(jwksUri));

      // Logged server-side once with jose diagnostic details
      const loggedError = serverLogs.find(l => l.includes('[Auth] JWT verification failed'));
      assert.ok(loggedError, 'Expected server-side error log for JWT verification failure');
      assert.match(loggedError, /ERR_JWT_EXPIRED/);
    } finally {
      console.error = origError;
      await app.close();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('missing required scope returns insufficient_scope without internal details', async () => {
    const { server, jwksUri, createToken } = await setupJwks();
    const tokenWithoutScope = await createToken({ scopes: ['read_only'] });

    const app = await serve({
      config: {
        ...testConfig({ apiKeys: [] }),
        jwt: {
          jwksUri,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          requiredScopes: ['settle'],
        },
      },
    });

    try {
      const res = await app.post('/verify', VALID_BODY, {
        authorization: `Bearer ${tokenWithoutScope}`,
      });

      assert.equal(res.status, 401);
      const rawText = await res.text();
      const body = JSON.parse(rawText);

      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'insufficient_scope');
      assert.equal(body.invalidMessage, 'unauthorized');
      assert.equal(body.reason, 'insufficient_scope');
      assert.doesNotMatch(rawText, /missing_required_scope/);
    } finally {
      await app.close();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('invalid signature returns invalid_token without jose diagnostics', async () => {
    const { server, jwksUri, createToken } = await setupJwks();
    const otherKeys = await generateKeyPair('EdDSA');
    const badSigToken = await createToken({ key: otherKeys.privateKey });

    const app = await serve({
      config: {
        ...testConfig({ apiKeys: [] }),
        jwt: {
          jwksUri,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          requiredScopes: ['settle'],
        },
      },
    });

    try {
      const res = await app.post('/verify', VALID_BODY, {
        authorization: `Bearer ${badSigToken}`,
      });

      assert.equal(res.status, 401);
      const rawText = await res.text();
      const body = JSON.parse(rawText);

      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'invalid_token');
      assert.equal(body.invalidMessage, 'unauthorized');
      assert.equal(body.reason, 'invalid_token');
      assert.doesNotMatch(rawText, /ERR_JWS_SIGNATURE_VERIFICATION_FAILED/);
      assert.doesNotMatch(rawText, /signature verification failed/);
    } finally {
      await app.close();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('JWKS fetch error returns invalid_token and does not leak JWKS URI', async () => {
    const unreachableJwksUri = 'http://127.0.0.1:1/nonexistent.json';
    const otherKeys = await generateKeyPair('EdDSA');
    const token = await new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setExpirationTime('5m')
      .sign(otherKeys.privateKey);

    const app = await serve({
      config: {
        ...testConfig({ apiKeys: [] }),
        jwt: {
          jwksUri: unreachableJwksUri,
        },
      },
    });

    try {
      const res = await app.post('/verify', VALID_BODY, {
        authorization: `Bearer ${token}`,
      });

      assert.equal(res.status, 401);
      const rawText = await res.text();
      const body = JSON.parse(rawText);

      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'invalid_token');
      assert.equal(body.reason, 'invalid_token');
      assert.doesNotMatch(rawText, /127\.0\.0\.1:1/);
      assert.doesNotMatch(rawText, /fetch failed/);
    } finally {
      await app.close();
    }
  });

  test('API-key body remains unchanged when both JWT and API keys are configured', async () => {
    const { server, jwksUri } = await setupJwks();
    const app = await serve({
      config: {
        ...testConfig({ apiKeys: [API_KEY] }),
        jwt: {
          jwksUri,
        },
      },
    });

    try {
      const res = await app.post('/verify', VALID_BODY, {
        authorization: 'Bearer wrong-api-key',
      });

      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'invalid_api_key');
      assert.equal(body.invalidMessage, 'unauthorized');
      assert.equal(body.reason, 'invalid_api_key');
    } finally {
      await app.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
