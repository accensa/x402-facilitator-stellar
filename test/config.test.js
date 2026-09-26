/**
 * @file config.test.js
 * @description Unit tests for {@link resolveConfig} in `src/config.js`.
 *
 * `resolveConfig` accepts a plain env-var object and returns a fully-typed
 * configuration tree. Passing env in rather than reading `process.env` directly
 * makes every test a pure function call with no global side-effects.
 *
 * ### Structure
 * - **Helpers** (`baseEnv`, `withPubnet`, `resolveWith`) — tiny, named
 *   builders that construct env objects so the repetitive boilerplate does not
 *   obscure what each test is actually asserting.
 * - **Grouped tests** — each logical concern (defaults, pubnet, rate limits,
 *   port, fee stroops) lives in its own block for easier navigation and
 *   isolated failure messages.
 *
 * All tests are synchronous and offline (no network, no `.env` file needed).
 */

import test from 'node:test';
import assert from 'node:assert';
import { resolveConfig, TESTNET, PUBNET } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid env object for testnet-only configurations.
 * Every test that needs a valid base extends this rather than repeating the
 * mandatory `FACILITATOR_SECRET` key.
 *
 * @returns {Record<string, string>} A fresh copy of the minimal env.
 */
function baseEnv() {
  return { FACILITATOR_SECRET: 'S123' };
}

/**
 * Minimal valid env for configurations with pubnet enabled.
 * Extends {@link baseEnv} with the three env vars pubnet mandates:
 * `ENABLE_PUBNET`, `FACILITATOR_SECRET_PUBNET`, and `STELLAR_RPC_URL_PUBNET`.
 *
 * @param {Record<string, string>} [overrides={}] - Additional or overriding
 *   env vars to merge in after the pubnet defaults.
 * @returns {Record<string, string>} A fully valid pubnet env object.
 */
function withPubnet(overrides = {}) {
  return {
    ...baseEnv(),
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
    ...overrides,
  };
}

/**
 * Calls `resolveConfig` with `baseEnv()` merged with `overrides`.
 * Convenience wrapper so individual tests read as assertions about a single
 * env-var change rather than a full env construction.
 *
 * @param {Record<string, string>} [overrides={}] - Env vars to add/override.
 * @returns {ReturnType<typeof resolveConfig>} The resolved config object.
 */
function resolveWith(overrides = {}) {
  return resolveConfig({ ...baseEnv(), ...overrides });
}

/**
 * Asserts that `resolveConfig` throws for each value in `badValues`, with an
 * error message matching `pattern`. Drives boundary and invalid-value tests
 * so each variant does not need its own `assert.throws` call.
 *
 * @param {Record<string, string>} baseOverrides - Env vars applied to every
 *   variant (e.g. pubnet prerequisites for a pubnet-specific field).
 * @param {string}   envKey    - The env-var key being tested (e.g. `'PORT'`).
 * @param {string[]} badValues - Values that must all cause a throw.
 * @param {RegExp}   pattern   - Pattern the error message must match.
 */
function assertRejectsAll(baseOverrides, envKey, badValues, pattern) {
  for (const bad of badValues) {
    assert.throws(
      () => resolveConfig({ ...baseEnv(), ...baseOverrides, [envKey]: bad }),
      pattern,
      `${envKey}=${JSON.stringify(bad)} should throw matching ${pattern}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Defaults and basic resolution
// ---------------------------------------------------------------------------

test('resolveConfig: testnet only by default', () => {
  const config = resolveConfig(baseEnv());
  assert.deepStrictEqual(config.networks, [TESTNET]);
  assert.ok(config.perNetwork[TESTNET]);
  assert.strictEqual(config.perNetwork[TESTNET].secret, 'S123');
  assert.strictEqual(config.perNetwork[TESTNET].maxTransactionFeeStroops, 50000);
});

test('resolveConfig: nodeEnv defaults to development', () => {
  assert.strictEqual(resolveWith().nodeEnv, 'development');
  assert.strictEqual(resolveWith({ NODE_ENV: 'production' }).nodeEnv, 'production');
});

test('resolveConfig: CORS origins are a trimmed comma-separated list', () => {
  const config = resolveWith({
    CORS_ALLOWED_ORIGINS: ' https://a.example , https://b.example ,',
  });
  assert.deepStrictEqual(config.cors.allowedOrigins, ['https://a.example', 'https://b.example']);

  // Absent or empty CORS_ALLOWED_ORIGINS yields an empty array — no wildcard.
  assert.deepStrictEqual(resolveWith().cors.allowedOrigins, []);
});

// ---------------------------------------------------------------------------
// Secret validation
// ---------------------------------------------------------------------------

test('resolveConfig: requires secret', () => {
  // Missing secret entirely.
  assert.throws(() => resolveConfig({}), /FACILITATOR_SECRET is required/);
  // Public key (G-prefix) must be rejected — only S-prefixed secret keys work.
  assert.throws(() => resolveConfig({ FACILITATOR_SECRET: 'G123' }), /starts with S/);
});

// ---------------------------------------------------------------------------
// Pubnet
// ---------------------------------------------------------------------------

test('resolveConfig: pubnet requires its own secret', () => {
  assert.throws(
    () => resolveConfig({ ...baseEnv(), ENABLE_PUBNET: 'true' }),
    /FACILITATOR_SECRET_PUBNET is required/,
  );
});

test('resolveConfig: pubnet requires its own RPC URL', () => {
  assert.throws(
    () =>
      resolveConfig({
        ...baseEnv(),
        ENABLE_PUBNET: 'true',
        FACILITATOR_SECRET_PUBNET: 'S456',
      }),
    /STELLAR_RPC_URL_PUBNET is unset/,
  );
});

test('resolveConfig: pubnet sets per-network values correctly', () => {
  const config = resolveConfig({
    FACILITATOR_SECRET: 'S123',
    STELLAR_RPC_URL: 'https://testnet.local',
    MAX_TX_FEE_STROOPS: '10000',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
    MAX_TX_FEE_STROOPS_PUBNET: '20000',
  });

  assert.deepStrictEqual(config.networks, [TESTNET, PUBNET]);

  assert.strictEqual(config.perNetwork[TESTNET].secret, 'S123');
  assert.strictEqual(config.perNetwork[TESTNET].rpcUrl, 'https://testnet.local');
  assert.strictEqual(config.perNetwork[TESTNET].maxTransactionFeeStroops, 10000);

  assert.strictEqual(config.perNetwork[PUBNET].secret, 'S456');
  assert.strictEqual(config.perNetwork[PUBNET].rpcUrl, 'https://pubnet.local');
  assert.strictEqual(config.perNetwork[PUBNET].maxTransactionFeeStroops, 20000);
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

test('resolves custom rate limits from RATE_LIMIT_GLOBAL and RATE_LIMIT_<key>', () => {
  const config = resolveWith({
    FACILITATOR_API_KEYS: 'admin:secret123, user:secret456',
    RATE_LIMIT_GLOBAL:
      'verify_rpm=100,settle_rpm=10,settle_rph=50,settle_rpd=500,fee_spd=1000,catalog_rpm=5',
    RATE_LIMIT_admin: 'verify_rpm=1000,fee_spd=2000,catalog_rpm=50',
  });

  // Global overrides are applied.
  assert.equal(config.rateLimits.global.verifyRpm, 100);
  assert.equal(config.rateLimits.global.settleRph, 50);
  assert.equal(config.rateLimits.global.catalogRpm, 5);

  // Key ids are normalized to uppercase to match the auth layer's normalisation.
  assert.equal(config.rateLimits.keys.ADMIN.verifyRpm, 1000);
  assert.equal(config.rateLimits.keys.ADMIN.catalogRpm, 50);

  // Unspecified per-key limits fall back to the global value.
  assert.equal(
    config.rateLimits.keys.ADMIN.settleRph,
    100,
    'unset per-key limit should fall back to global default (100), not 50',
  );
});

// ---------------------------------------------------------------------------
// PORT
// ---------------------------------------------------------------------------

test('resolveConfig: PORT defaults to 3402 when unset', () => {
  assert.strictEqual(resolveWith().port, 3402);
});

test('resolveConfig: rpcForceIpv4 defaults to true and parses RPC_FORCE_IPV4', () => {
  assert.strictEqual(resolveWith().rpcForceIpv4, true);
  assert.strictEqual(resolveWith({ RPC_FORCE_IPV4: 'false' }).rpcForceIpv4, false);
  assert.strictEqual(resolveWith({ RPC_FORCE_IPV4: 'true' }).rpcForceIpv4, true);
});

test('resolveConfig: PORT rejects non-numeric and out-of-range values', () => {
  assertRejectsAll(
    {},
    'PORT',
    ['abc', '12.5', '-1', '0', '65536', ''],
    /PORT must be a finite integer between 1 and 65535/,
  );
});

test('resolveConfig: PORT accepts range boundary values', () => {
  assert.strictEqual(resolveWith({ PORT: '1' }).port, 1);
  assert.strictEqual(resolveWith({ PORT: '65535' }).port, 65535);
});

// ---------------------------------------------------------------------------
// MAX_TX_FEE_STROOPS (testnet)
// ---------------------------------------------------------------------------

test('resolveConfig: MAX_TX_FEE_STROOPS defaults to 50000 when unset', () => {
  assert.strictEqual(resolveWith().perNetwork[TESTNET].maxTransactionFeeStroops, 50000);
});

test('resolveConfig: MAX_TX_FEE_STROOPS rejects non-numeric and out-of-range values', () => {
  assertRejectsAll(
    {},
    'MAX_TX_FEE_STROOPS',
    ['abc', '12.5', '-100', '0', '99', '10000001'],
    /MAX_TX_FEE_STROOPS must be a finite integer between 100 and 10000000/,
  );
});

test('resolveConfig: MAX_TX_FEE_STROOPS accepts range boundary values', () => {
  assert.strictEqual(
    resolveWith({ MAX_TX_FEE_STROOPS: '100' }).perNetwork[TESTNET].maxTransactionFeeStroops,
    100,
  );
  assert.strictEqual(
    resolveWith({ MAX_TX_FEE_STROOPS: '10000000' }).perNetwork[TESTNET].maxTransactionFeeStroops,
    10000000,
  );
});

// ---------------------------------------------------------------------------
// MAX_TX_FEE_STROOPS_PUBNET
// ---------------------------------------------------------------------------

test('resolveConfig: MAX_TX_FEE_STROOPS_PUBNET defaults to 50000 when unset', () => {
  assert.strictEqual(
    resolveConfig(withPubnet()).perNetwork[PUBNET].maxTransactionFeeStroops,
    50000,
  );
});

test('resolveConfig: MAX_TX_FEE_STROOPS_PUBNET rejects non-numeric and out-of-range values', () => {
  assertRejectsAll(
    withPubnet(),
    'MAX_TX_FEE_STROOPS_PUBNET',
    ['abc', '12.5', '-100', '0', '99', '10000001'],
    /MAX_TX_FEE_STROOPS_PUBNET must be a finite integer between 100 and 10000000/,
  );
});
