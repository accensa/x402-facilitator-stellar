/**
 * Issue #667 - 401 responses must carry WWW-Authenticate: Bearer challenge header.
 *
 * RFC 9110 requires a challenge on 401 Unauthorized responses. Generic clients
 * require this header to attach credentials. Every 401 emitted from createAuthMiddleware
 * and createAuthMiddlewareWithJwt must include `WWW-Authenticate: Bearer`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAuthMiddleware } from '../src/auth.js';
import { createAuthMiddlewareWithJwt } from '../src/auth-http.js';
import { serve, testConfig, VALID_BODY } from './helpers/app.js';

function hash(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

const TEST_SECRET = 's3cret-0123456789abcdefghijklmnopqrstuvwxyz';

function createMockReply() {
  const headers = {};
  let statusCode = 200;
  let sentBody = null;

  const reply = {
    header(name, value) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    code(c) {
      statusCode = c;
      return reply;
    },
    send(body) {
      sentBody = body;
      return reply;
    },
    getHeaders: () => headers,
    getStatusCode: () => statusCode,
    getBody: () => sentBody,
  };
  return reply;
}

describe('401 WWW-Authenticate challenge header (#667)', () => {
  describe('createAuthMiddleware unit checks', () => {
    test('missing key returns 401 with WWW-Authenticate: Bearer', async () => {
      const keys = [{ id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: null, revoked: false }];
      const { requireApiKey } = createAuthMiddleware({
        config: { apiKeys: keys },
        audit: () => {},
      });

      const reply = createMockReply();
      const req = { headers: {}, ip: '127.0.0.1' };
      await requireApiKey(req, reply);

      assert.equal(reply.getStatusCode(), 401);
      assert.equal(reply.getHeaders()['www-authenticate'], 'Bearer');
      assert.equal(reply.getBody().invalidReason, 'missing_auth_header');
    });

    test('bad key returns 401 with WWW-Authenticate: Bearer', async () => {
      const keys = [{ id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: null, revoked: false }];
      const { requireApiKey } = createAuthMiddleware({
        config: { apiKeys: keys },
        audit: () => {},
      });

      const reply = createMockReply();
      const req = { headers: { authorization: 'Bearer wrong-key' }, ip: '127.0.0.1' };
      await requireApiKey(req, reply);

      assert.equal(reply.getStatusCode(), 401);
      assert.equal(reply.getHeaders()['www-authenticate'], 'Bearer');
      assert.equal(reply.getBody().invalidReason, 'invalid_api_key');
    });

    test('revoked key returns 401 with WWW-Authenticate: Bearer', async () => {
      const keys = [{ id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: null, revoked: true }];
      const { requireApiKey } = createAuthMiddleware({
        config: { apiKeys: keys },
        audit: () => {},
      });

      const reply = createMockReply();
      const req = { headers: { authorization: `Bearer ${TEST_SECRET}` }, ip: '127.0.0.1' };
      await requireApiKey(req, reply);

      assert.equal(reply.getStatusCode(), 401);
      assert.equal(reply.getHeaders()['www-authenticate'], 'Bearer');
      assert.equal(reply.getBody().invalidReason, 'revoked_api_key');
    });

    test('requireApiKeyStrict in open mode returns 401 with WWW-Authenticate: Bearer', async () => {
      const { requireApiKeyStrict } = createAuthMiddleware({
        config: { apiKeys: [] },
        audit: () => {},
      });

      const reply = createMockReply();
      const req = { headers: {}, ip: '127.0.0.1' };
      await requireApiKeyStrict(req, reply);

      assert.equal(reply.getStatusCode(), 401);
      assert.equal(reply.getHeaders()['www-authenticate'], 'Bearer');
      assert.equal(reply.getBody().invalidReason, 'open_mode_usage_forbidden');
    });
  });

  describe('createAuthMiddlewareWithJwt unit checks', () => {
    test('missing key returns 401 with WWW-Authenticate: Bearer', async () => {
      const keys = [{ id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: null, revoked: false }];
      const { requireApiKey } = createAuthMiddlewareWithJwt({
        config: { apiKeys: keys },
        audit: () => {},
      });

      const reply = createMockReply();
      const req = { headers: {}, ip: '127.0.0.1' };
      await requireApiKey(req, reply);

      assert.equal(reply.getStatusCode(), 401);
      assert.equal(reply.getHeaders()['www-authenticate'], 'Bearer');
      assert.equal(reply.getBody().invalidReason, 'missing_auth_header');
    });

    test('bad key returns 401 with WWW-Authenticate: Bearer', async () => {
      const keys = [{ id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: null, revoked: false }];
      const { requireApiKey } = createAuthMiddlewareWithJwt({
        config: { apiKeys: keys },
        audit: () => {},
      });

      const reply = createMockReply();
      const req = { headers: { authorization: 'Bearer wrong-key' }, ip: '127.0.0.1' };
      await requireApiKey(req, reply);

      assert.equal(reply.getStatusCode(), 401);
      assert.equal(reply.getHeaders()['www-authenticate'], 'Bearer');
      assert.equal(reply.getBody().invalidReason, 'invalid_api_key');
    });

    test('revoked key returns 401 with WWW-Authenticate: Bearer', async () => {
      const keys = [{ id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: null, revoked: true }];
      const { requireApiKey } = createAuthMiddlewareWithJwt({
        config: { apiKeys: keys },
        audit: () => {},
      });

      const reply = createMockReply();
      const req = { headers: { authorization: `Bearer ${TEST_SECRET}` }, ip: '127.0.0.1' };
      await requireApiKey(req, reply);

      assert.equal(reply.getStatusCode(), 401);
      assert.equal(reply.getHeaders()['www-authenticate'], 'Bearer');
      assert.equal(reply.getBody().invalidReason, 'revoked_api_key');
    });

    test('requireApiKeyStrict in open mode returns 401 with WWW-Authenticate: Bearer', async () => {
      const { requireApiKeyStrict } = createAuthMiddlewareWithJwt({
        config: { apiKeys: [] },
        audit: () => {},
      });

      const reply = createMockReply();
      const req = { headers: {}, ip: '127.0.0.1' };
      await requireApiKeyStrict(req, reply);

      assert.equal(reply.getStatusCode(), 401);
      assert.equal(reply.getHeaders()['www-authenticate'], 'Bearer');
      assert.equal(reply.getBody().invalidReason, 'open_mode_usage_forbidden');
    });
  });

  describe('HTTP endpoints over wire carry WWW-Authenticate challenge', () => {
    test('missing auth header returns 401 with WWW-Authenticate: Bearer', async () => {
      const app = await serve({
        config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }),
      });
      try {
        const res = await app.post('/verify', VALID_BODY);
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      } finally {
        await app.close();
      }
    });

    test('bad API key returns 401 with WWW-Authenticate: Bearer', async () => {
      const app = await serve({
        config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }),
      });
      try {
        const res = await app.post('/verify', VALID_BODY, {
          authorization: 'Bearer incorrect-secret',
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      } finally {
        await app.close();
      }
    });

    test('revoked key returns 401 with WWW-Authenticate: Bearer', async () => {
      const keys = [{ id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: null, revoked: true }];
      const app = await serve({
        config: { ...testConfig(), apiKeys: keys },
      });
      try {
        const res = await app.post('/verify', VALID_BODY, {
          authorization: `Bearer ${TEST_SECRET}`,
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      } finally {
        await app.close();
      }
    });

    test('/usage in open mode returns 401 with WWW-Authenticate: Bearer', async () => {
      const app = await serve({
        config: testConfig({ apiKeys: [] }),
      });
      try {
        const res = await app.get('/usage');
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      } finally {
        await app.close();
      }
    });
  });
});
