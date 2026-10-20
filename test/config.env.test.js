import test from 'node:test';
import assert from 'node:assert';
import { resolveConfig } from '../src/config.js';

// resolveConfig validates signer secrets with a checksum-aware StrKey decode
// (#498), so this fixture is a real ed25519 seed rather than an "S"-prefixed
// placeholder.
const SECRET = 'SAO2MAIQCR5T27QDICO3QJTD2YZ4PMEAVLCLQ6AANVGPCZ53TEACPDOQ';

test('trustProxy: unset by default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: SECRET });
  assert.strictEqual(config.trustProxy, undefined);
});

test('trustProxy: hop count parses to a number', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: SECRET, TRUST_PROXY: '1' });
  assert.strictEqual(config.trustProxy, 1);
});

test('trustProxy: comma-separated list parses to an array', () => {
  const config = resolveConfig({
    FACILITATOR_SECRET: SECRET,
    TRUST_PROXY: '10.0.0.5, 10.0.0.6, loopback',
  });
  assert.deepStrictEqual(config.trustProxy, ['10.0.0.5', '10.0.0.6', 'loopback']);
});

test('trustProxy: boolean-ish values are rejected', () => {
  // "true" trusts the leftmost client-written XFF entry — never acceptable.
  for (const bad of ['true', 'TRUE', 'yes', 'no']) {
    assert.throws(
      () => resolveConfig({ FACILITATOR_SECRET: SECRET, TRUST_PROXY: bad }),
      /must be a hop count/,
      `TRUST_PROXY=${bad} should throw`,
    );
  }
});

test('config: optional store URLs pass through as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: SECRET });
  assert.strictEqual(config.redisUrl, null);
  assert.strictEqual(config.databaseUrl, null);
});

test('config: store URLs pass through when set', () => {
  const config = resolveConfig({
    FACILITATOR_SECRET: SECRET,
    REDIS_URL: 'redis://redis:6379',
    DATABASE_URL: 'postgres://u:p@db:5432/x402',
  });
  assert.strictEqual(config.redisUrl, 'redis://redis:6379');
  assert.strictEqual(config.databaseUrl, 'postgres://u:p@db:5432/x402');
});
