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
