/**
 * Caller authentication over HTTP.
 *
 * Every assertion here is carried over from the original subprocess version.
 * What changed is how the server is obtained: this builds the app in-process
 * via createApp rather than spawning `node src/server.js` and polling stdout
 * for "listening on".
 *
 * That mattered in practice. The spawn version had no timeout, so when
 * src/config.js was merged in a state that did not parse, the child died on
 * startup, the "listening on" line never arrived, and the promise never
 * settled — the suite reported `Promise resolution is still pending but the
 * event loop has already resolved` instead of the syntax error. It also bound
 * fixed ports (3409, 3410) and needed a real keypair to get past boot.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, testConfig, VALID_BODY } from './helpers/app.js';

describe('with API keys configured', () => {
  let app;
  before(async () => {
    app = await serve({ config: testConfig({ apiKeys: ['admin:supersecret'] }) });
  });
  after(() => app.close());

  test('missing header', async () => {
    const res = await app.post('/verify', {});
    assert.equal(res.status, 401);
    assert.equal((await res.json()).reason, 'missing_auth_header');
  });

  test('malformed header', async () => {
    const res = await app.post('/verify', {}, { authorization: 'Bearer token extra' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).reason, 'malformed_auth_header');
  });

  test('invalid key', async () => {
    const res = await app.post('/verify', {}, { authorization: 'Bearer wrongsecret' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).reason, 'invalid_api_key');
  });

  test('valid key (Bearer) passes auth and reaches body validation', async () => {
    // 400, not 401: the empty body is rejected by readPaymentBody, which only
    // runs once the key has been accepted.
    const res = await app.post('/verify', {}, { authorization: 'Bearer supersecret' });
    assert.equal(res.status, 400);
  });

  test('valid key (plain, no Bearer prefix)', async () => {
    const res = await app.post('/verify', {}, { authorization: 'supersecret' });
    assert.equal(res.status, 400);
  });

  test('a wrong key of a different length is rejected, not crashed on', async () => {
    // timingSafeEqual throws on length mismatch, which is why the comparison is
    // over fixed-width SHA-256 digests rather than the raw keys.
    const res = await app.post('/verify', {}, { authorization: 'Bearer x' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).reason, 'invalid_api_key');
  });

  test('the key id is attached to the request, not the key', async () => {
    // /usage echoes req.keyId, which is how a caller is identified in metering
    // and logs without the secret travelling with it. Key ids are normalized
    // to uppercase at auth.
    const res = await app.get('/usage', { authorization: 'Bearer supersecret' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).keyId, 'ADMIN');
  });

  test('both /verify and /settle are protected', async () => {
    for (const route of ['/verify', '/settle']) {
      const res = await app.post(route, VALID_BODY);
      assert.equal(res.status, 401, `${route} must require a key`);
    }
  });
});

describe('with several keys configured', () => {
  let app;
  before(async () => {
    app = await serve({ config: testConfig({ apiKeys: ['first:aaa', 'second:bbb'] }) });
  });
  after(() => app.close());

  test('every key works, not just the first', async () => {
    for (const [key, id] of [
      ['aaa', 'FIRST'],
      ['bbb', 'SECOND'],
    ]) {
      const res = await app.get('/usage', { authorization: `Bearer ${key}` });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).keyId, id);
    }
  });
});

describe('open mode', () => {
  let app;
  before(async () => {
    app = await serve();
  });
  after(() => app.close());

  test('passes without a header', async () => {
    // 400 because the body is empty, but auth passed — which is the point.
    const res = await app.post('/verify', {});
    assert.equal(res.status, 400);
  });

  test('an Authorization header is ignored rather than rejected', async () => {
    // With no keys configured there is nothing to check it against, and
    // refusing a caller who volunteered one would be surprising.
    const res = await app.post('/verify', {}, { authorization: 'Bearer anything' });
    assert.equal(res.status, 400);
  });
});
