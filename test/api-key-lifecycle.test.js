/**
 * API key lifecycle: entropy, expiry and revocation (#207).
 *
 * Before this, a key's whole strength was a single unsalted SHA-256 digest —
 * which is not a work factor — so a one-character secret was as strong as the
 * hash made it, and nothing stopped a key from living forever or being
 * impossible to withdraw. These tests pin the three controls: a boot-time
 * entropy floor, a per-request expiry, and a revocation list that names ids
 * rather than secrets.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveConfig, MIN_API_KEY_LENGTH } from '../src/config.js';
import { verifyApiKey } from '../src/auth.js';
import { serve, testConfig, TEST_SECRET } from './helpers/app.js';

const BASE_ENV = { FACILITATOR_SECRET: 'S123', STELLAR_RPC_URL: 'https://rpc.test' };
const resolveWith = overrides => resolveConfig({ ...BASE_ENV, ...overrides });

const LONG = 'a'.repeat(MIN_API_KEY_LENGTH);
const hash = secret => crypto.createHash('sha256').update(secret).digest();

describe('entropy floor (#207)', () => {
  test('MIN_API_KEY_LENGTH is 32', () => {
    assert.equal(MIN_API_KEY_LENGTH, 32);
  });

  test('a secret one character short is refused at boot, naming the key and the floor', () => {
    assert.throws(
      () => resolveWith({ FACILITATOR_API_KEYS: `admin:${'a'.repeat(MIN_API_KEY_LENGTH - 1)}` }),
      err => {
        assert.match(err.message, /API key "admin" has a 31-character secret/);
        assert.match(err.message, /at least 32 are required/);
        assert.match(err.message, /openssl rand -base64 32/, 'the message must say how to fix it');
        return true;
      },
    );
  });

  test('a secret at exactly the floor is accepted', () => {
    const config = resolveWith({ FACILITATOR_API_KEYS: `admin:${LONG}` });
    assert.equal(config.apiKeys.length, 1);
    assert.equal(config.apiKeys[0].id, 'admin');
  });

  test('the check is on the secret, not the whole `id:secret` entry', () => {
    // An id long enough to pad the entry past 32 must not rescue a short secret.
    assert.throws(
      () => resolveWith({ FACILITATOR_API_KEYS: `${'i'.repeat(40)}:short` }),
      /has a 5-character secret/,
    );
  });

  test('a key with no id is still checked', () => {
    assert.throws(
      () => resolveWith({ FACILITATOR_API_KEYS: 'tooshort' }),
      /API key "key_0" has a 8-character secret/,
    );
  });
});

describe('expiry (#207)', () => {
  test('parses the optional epoch-seconds expiry into milliseconds', () => {
    const config = resolveWith({ FACILITATOR_API_KEYS: `admin:${LONG}:1798761600` });
    assert.equal(config.apiKeys[0].expiresAt, 1798761600 * 1000);
    // The expiry must not be left glued onto the secret.
    assert.deepEqual(config.apiKeys[0].hash, hash(LONG));
  });

  test('a key with no expiry is valid indefinitely', () => {
    const config = resolveWith({ FACILITATOR_API_KEYS: `admin:${LONG}` });
    assert.equal(config.apiKeys[0].expiresAt, null);
  });

  test('an unparseable expiry is refused, with an example of the right form', () => {
    assert.throws(
      () => resolveWith({ FACILITATOR_API_KEYS: `admin:${LONG}:2026-01-01T00:00:00Z` }),
      /unparseable expiry/,
    );
  });

  test('an expired key that still matches is refused, with reason expired_api_key', () => {
    const keys = [{ id: 'ADMIN', hash: hash(LONG), expiresAt: 1_000_000, revoked: false }];
    const before = verifyApiKey(`Bearer ${LONG}`, keys, 999_999);
    assert.equal(before.valid, true, 'the key must work right up to its expiry');

    const after = verifyApiKey(`Bearer ${LONG}`, keys, 1_000_000);
    assert.equal(after.valid, false);
    assert.equal(after.reason, 'expired_api_key');
  });

  test('expiry is enforced per request, not once at boot', async () => {
    // A process that boots with a key valid for one more instant must stop
    // accepting it when that instant passes, without a redeploy. The clock is
    // advanced by moving the key's own expiry into the past: the object is the
    // one the middleware captured at boot, so a check made once at startup
    // would keep admitting it.
    const keys = [
      { id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: Date.now() + 60_000, revoked: false },
    ];
    const app = await serve({ config: { ...testConfig(), apiKeys: keys } });
    try {
      const ok = await app.get('/usage', { authorization: `Bearer ${TEST_SECRET}` });
      assert.equal(ok.status, 200, 'the key must work while unexpired');

      keys[0].expiresAt = Date.now() - 1;
      const expired = await app.get('/usage', { authorization: `Bearer ${TEST_SECRET}` });
      assert.equal(expired.status, 401, 'the same process must refuse it once expired');
      assert.equal((await expired.json()).invalidReason, 'expired_api_key');
    } finally {
      await app.close();
    }
  });
});

describe('revocation (#207)', () => {
  test('a key listed in FACILITATOR_REVOKED_API_KEYS is marked revoked', () => {
    const config = resolveWith({
      FACILITATOR_API_KEYS: `admin:${LONG},agent:${LONG}b`,
      FACILITATOR_REVOKED_API_KEYS: 'admin',
    });
    const byId = Object.fromEntries(config.apiKeys.map(k => [k.id, k]));
    assert.equal(byId.admin.revoked, true);
    assert.equal(byId.agent.revoked, false);
  });

  test('the revoked list is compared case-insensitively', () => {
    const config = resolveWith({
      FACILITATOR_API_KEYS: `admin:${LONG}`,
      FACILITATOR_REVOKED_API_KEYS: 'ADMIN',
    });
    assert.equal(config.apiKeys[0].revoked, true);
  });

  test('a revoked key that still matches is refused, with reason revoked_api_key', () => {
    const keys = [{ id: 'ADMIN', hash: hash(LONG), expiresAt: null, revoked: true }];
    const result = verifyApiKey(`Bearer ${LONG}`, keys);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'revoked_api_key');
  });

  test('a revoked id matching no key warns rather than silently revoking nothing', () => {
    const warnings = [];
    const original = console.warn;
    console.warn = msg => warnings.push(String(msg));
    try {
      resolveWith({
        FACILITATOR_API_KEYS: `admin:${LONG}`,
        FACILITATOR_REVOKED_API_KEYS: 'typo_key',
      });
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /lists "TYPO_KEY", which matches no key/);
  });

  test('revocation is not confused with an unknown key', () => {
    // The two must stay distinguishable: revoked means "this key existed", and
    // an operator reading logs needs to tell a withdrawn key from a wrong one.
    const keys = [{ id: 'ADMIN', hash: hash(LONG), expiresAt: null, revoked: true }];
    assert.equal(verifyApiKey(`Bearer ${LONG}`, keys).reason, 'revoked_api_key');
    assert.equal(verifyApiKey('Bearer someone-elses-key', keys).reason, 'invalid_api_key');
  });

  test('revocation is enforced over HTTP', async () => {
    const keys = [{ id: 'ADMIN', hash: hash(TEST_SECRET), expiresAt: null, revoked: true }];
    const app = await serve({ config: { ...testConfig(), apiKeys: keys } });
    try {
      const res = await app.get('/usage', { authorization: `Bearer ${TEST_SECRET}` });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).reason, 'revoked_api_key');
    } finally {
      await app.close();
    }
  });
});
