import test from 'node:test';
import assert from 'node:assert';
import { resolveConfig, TESTNET, PUBNET } from '../src/config.js';

test('resolveConfig: testnet only by default', () => {
  const env = { FACILITATOR_SECRET: 'S123' };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.networks, [TESTNET]);
  assert.ok(config.perNetwork[TESTNET]);
  assert.strictEqual(config.perNetwork[TESTNET].secret, 'S123');
  assert.strictEqual(config.perNetwork[TESTNET].maxTransactionFeeStroops, 50000);
});

test('resolveConfig: nodeEnv defaults to development', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.nodeEnv, 'development');
  assert.strictEqual(
    resolveConfig({ FACILITATOR_SECRET: 'S123', NODE_ENV: 'production' }).nodeEnv,
    'production',
  );
});

test('resolveConfig: CORS origins are a trimmed comma-separated list', () => {
  const config = resolveConfig({
    FACILITATOR_SECRET: 'S123',
    CORS_ALLOWED_ORIGINS: ' https://a.example , https://b.example ,',
  });
  assert.deepStrictEqual(config.cors.allowedOrigins, ['https://a.example', 'https://b.example']);

  const empty = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.deepStrictEqual(empty.cors.allowedOrigins, []);
});

test('resolveConfig: requires secret', () => {
  assert.throws(() => resolveConfig({}), /FACILITATOR_SECRET is required/);
  assert.throws(() => resolveConfig({ FACILITATOR_SECRET: 'G123' }), /starts with S/);
});

test('resolveConfig: pubnet requires its own secret', () => {
  const env = { FACILITATOR_SECRET: 'S123', ENABLE_PUBNET: 'true' };
  assert.throws(() => resolveConfig(env), /FACILITATOR_SECRET_PUBNET is required/);
});

test('resolveConfig: pubnet requires its own RPC URL', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
  };
  assert.throws(() => resolveConfig(env), /STELLAR_RPC_URL_PUBNET is unset/);
});

test('resolveConfig: pubnet sets per-network values correctly', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    STELLAR_RPC_URL: 'https://testnet.local',
    MAX_TX_FEE_STROOPS: '10000',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
    MAX_TX_FEE_STROOPS_PUBNET: '20000',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.networks, [TESTNET, PUBNET]);

  assert.strictEqual(config.perNetwork[TESTNET].secret, 'S123');
  assert.strictEqual(config.perNetwork[TESTNET].rpcUrl, 'https://testnet.local');
  assert.strictEqual(config.perNetwork[TESTNET].maxTransactionFeeStroops, 10000);

  assert.strictEqual(config.perNetwork[PUBNET].secret, 'S456');
  assert.strictEqual(config.perNetwork[PUBNET].rpcUrl, 'https://pubnet.local');
  assert.strictEqual(config.perNetwork[PUBNET].maxTransactionFeeStroops, 20000);
});

test('resolves custom rate limits from RATE_LIMIT_GLOBAL and RATE_LIMIT_<key>', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    FACILITATOR_API_KEYS: 'admin:secret123, user:secret456',
    RATE_LIMIT_GLOBAL:
      'verify_rpm=100,settle_rpm=10,settle_rph=50,settle_rpd=500,fee_spd=1000,catalog_rpm=5',
    RATE_LIMIT_admin: 'verify_rpm=1000,fee_spd=2000,catalog_rpm=50',
  };
  const config = resolveConfig(env);
  assert.equal(config.rateLimits.global.verifyRpm, 100);
  assert.equal(config.rateLimits.global.settleRph, 50);
  assert.equal(config.rateLimits.global.catalogRpm, 5);

  // Key ids are normalized to uppercase (the auth layer uppercases req.keyId,
  // so per-key limits are keyed by the normalized id).
  assert.equal(config.rateLimits.keys.ADMIN.verifyRpm, 1000);
  assert.equal(config.rateLimits.keys.ADMIN.catalogRpm, 50);
  // Unspecified per-key limits fall back to global
  assert.equal(config.rateLimits.keys.ADMIN.settleRph, 100);
});

test('resolveConfig: PORT defaults to 3402 when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.port, 3402);
});

test('resolveConfig: PORT rejects non-numeric and out-of-range values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  for (const bad of ['abc', '12.5', '-1', '0', '65536', '']) {
    assert.throws(
      () => resolveConfig({ ...base, PORT: bad }),
      /PORT must be a finite integer between 1 and 65535/,
      `PORT=${JSON.stringify(bad)} should throw`,
    );
  }
});

test('resolveConfig: PORT accepts range boundary values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  assert.strictEqual(resolveConfig({ ...base, PORT: '1' }).port, 1);
  assert.strictEqual(resolveConfig({ ...base, PORT: '65535' }).port, 65535);
});

test('resolveConfig: MAX_TX_FEE_STROOPS defaults to 50000 when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.perNetwork[TESTNET].maxTransactionFeeStroops, 50000);
});

test('resolveConfig: MAX_TX_FEE_STROOPS rejects non-numeric and out-of-range values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  for (const bad of ['abc', '12.5', '-100', '0', '99', '10000001']) {
    assert.throws(
      () => resolveConfig({ ...base, MAX_TX_FEE_STROOPS: bad }),
      /MAX_TX_FEE_STROOPS must be a finite integer between 100 and 10000000/,
      `MAX_TX_FEE_STROOPS=${JSON.stringify(bad)} should throw`,
    );
  }
});

test('resolveConfig: MAX_TX_FEE_STROOPS accepts range boundary values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  assert.strictEqual(resolveConfig({ ...base, MAX_TX_FEE_STROOPS: '100' }).perNetwork[TESTNET].maxTransactionFeeStroops, 100);
  assert.strictEqual(resolveConfig({ ...base, MAX_TX_FEE_STROOPS: '10000000' }).perNetwork[TESTNET].maxTransactionFeeStroops, 10000000);
});

test('resolveConfig: MAX_TX_FEE_STROOPS_PUBNET defaults to 50000 when unset', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[PUBNET].maxTransactionFeeStroops, 50000);
});

test('resolveConfig: MAX_TX_FEE_STROOPS_PUBNET rejects non-numeric and out-of-range values', () => {
  const base = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
  };
  for (const bad of ['abc', '12.5', '-100', '0', '99', '10000001']) {
    assert.throws(
      () => resolveConfig({ ...base, MAX_TX_FEE_STROOPS_PUBNET: bad }),
      /MAX_TX_FEE_STROOPS_PUBNET must be a finite integer between 100 and 10000000/,
      `MAX_TX_FEE_STROOPS_PUBNET=${JSON.stringify(bad)} should throw`,
    );
  }
});
