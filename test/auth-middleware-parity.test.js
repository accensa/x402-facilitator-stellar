/**
 * @file auth-middleware-parity.test.js
 * @description The two API-key middlewares must speak one 401 contract (#673).
 *
 * `createAuthMiddleware` (`src/auth.js`) and `createAuthMiddlewareWithJwt`
 * (`src/auth-http.js`) do the same job with hand-written 401 bodies. Production
 * wires only the JWT-aware factory (`src/app.js`), while the older one is still
 * exported from `src/index.js`, so a client switching deployments can see two
 * different shapes for the same refusal. Nothing compared them, and the JWT
 * suite's own tests are `assert.ok(true)` placeholders.
 *
 * This test drives the same five refusals through both factories — the JWT one
 * through the real app (`serve`, as production wires it) and the legacy one
 * through a one-route harness, because `createApp` never mounts it — and
 * asserts the same status, the same key set and the same `invalidReason`.
 * `Object.keys` is sorted before comparison so an unrelated reordering does not
 * trip it; a dropped or added field does. The full 401 parity table is printed
 * on failure.
 *
 * No production change is made by this test: if the two middlewares disagree,
 * that is a finding for the PR, not something to paper over here.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createAuthMiddleware } from '../src/auth.js';
import { serve, testConfig, TEST_SECRET } from './helpers/app.js';

const REVOKED_SECRET = 'revoked-secret-0123456789abcdefghijklmnop';
const EXPIRED_SECRET = 'expired-secret-0123456789abcdefghijklmnop';
const UNKNOWN_SECRET = 'unknown-secret-0123456789abcdefghijklmnop';

/** The 401 body every auth refusal is documented to carry. */
const CONTRACT_KEYS = ['invalidMessage', 'invalidReason', 'isValid', 'reason'];

/**
 * Config with one usable key plus a revoked and an expired one, built through
 * `testConfig` because the harness hashes `id:secret` entries exactly the way
 * `resolveConfig` does. `testConfig` does not model lifecycle flags, so they
 * are set on the hashed entries afterwards.
 */
function keyedConfig() {
  const config = testConfig({
    apiKeys: [`admin:${TEST_SECRET}`, `revoked:${REVOKED_SECRET}`, `expired:${EXPIRED_SECRET}`],
  });
  config.apiKeys = config.apiKeys.map(key => {
    if (key.id === 'revoked') return { ...key, revoked: true };
    if (key.id === 'expired') return { ...key, expiresAt: Date.now() - 60_000 };
    return key;
  });
  return config;
}

/**
 * Mounts the legacy factory on the route shape the comparison uses.
 *
 * `serve`/`createApp` wires only the JWT-aware factory, so the legacy middleware
 * cannot be exercised through it; this harness keeps the request identical
 * (`POST /verify`, same headers) and stubs the handler so only the 401
 * preHandler path is under test.
 */
async function bootLegacyFactory(config) {
  const app = Fastify({ logger: false });
  const { requireApiKey } = createAuthMiddleware({ config, audit: () => {} });
  app.post('/verify', { preHandler: requireApiKey }, async () => ({ ok: true }));
  await app.ready();
  return {
    post: async headers => {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        headers: { 'content-type': 'application/json', ...headers },
        payload: {},
      });
      return { status: res.statusCode, body: res.json() };
    },
    close: () => app.close(),
  };
}

/** The five refusals both middlewares must agree on. */
const SCENARIOS = [
  { name: 'missing header', headers: {}, reason: 'missing_auth_header' },
  {
    name: 'malformed header',
    headers: { authorization: 'Bearer token extra' },
    reason: 'malformed_auth_header',
  },
  {
    name: 'unknown key',
    headers: { authorization: `Bearer ${UNKNOWN_SECRET}` },
    reason: 'invalid_api_key',
  },
  {
    name: 'revoked key',
    headers: { authorization: `Bearer ${REVOKED_SECRET}` },
    reason: 'revoked_api_key',
  },
  {
    name: 'expired key',
    headers: { authorization: `Bearer ${EXPIRED_SECRET}` },
    reason: 'expired_api_key',
  },
];

/** One row per scenario, shaped for a readable failure table. */
const summarize = (res, body) => ({
  status: res.status,
  keys: Object.keys(body).sort(),
  isValid: body.isValid,
  invalidReason: body.invalidReason,
  invalidMessage: body.invalidMessage,
  reason: body.reason,
});

describe('API-key middleware 401 parity (#673)', () => {
  test('the same five refusals produce the same 401 body through both factories', async () => {
    const config = keyedConfig();
    const legacy = await bootLegacyFactory(config);
    const production = await serve({ config });

    try {
      const rows = [];
      for (const scenario of SCENARIOS) {
        const legacyRes = await legacy.post(scenario.headers);
        const productionRes = await production.post('/verify', {}, scenario.headers);
        const legacyBody = legacyRes.body;
        const productionBody = await productionRes.json();
        rows.push({
          scenario: scenario.name,
          legacy: summarize(legacyRes, legacyBody),
          jwt: summarize(productionRes, productionBody),
          bodies: { legacy: legacyBody, production: productionBody },
        });
      }

      // The table, rendered once and attached to every failure so a mismatch
      // shows both middlewares side by side instead of just "not equal".
      const table = JSON.stringify(
        rows.map(row => ({ scenario: row.scenario, legacy: row.legacy, jwt: row.jwt })),
        null,
        2,
      );

      for (const row of rows) {
        const scenario = SCENARIOS.find(s => s.name === row.scenario);
        assert.equal(row.legacy.status, 401, `${row.scenario}: legacy must refuse\n${table}`);
        assert.equal(row.jwt.status, 401, `${row.scenario}: JWT-aware must refuse\n${table}`);

        assert.deepEqual(
          row.jwt.keys,
          row.legacy.keys,
          `${row.scenario}: the two 401 bodies must carry the same key set\n${table}`,
        );
        assert.deepEqual(
          row.legacy.keys,
          CONTRACT_KEYS,
          `${row.scenario}: the 401 contract is isValid/invalidReason/invalidMessage/reason\n${table}`,
        );

        assert.equal(
          row.legacy.invalidReason,
          scenario.reason,
          `${row.scenario}: legacy invalidReason\n${table}`,
        );
        assert.equal(
          row.jwt.invalidReason,
          scenario.reason,
          `${row.scenario}: JWT-aware invalidReason\n${table}`,
        );

        // Beyond shape: the values themselves must agree, so one factory
        // changing a message or dropping `reason` is caught here.
        assert.deepEqual(
          row.bodies.production,
          row.bodies.legacy,
          `${row.scenario}: the two 401 bodies must be identical\n${table}`,
        );
      }
    } finally {
      await legacy.close();
      await production.close();
    }
  });
});
