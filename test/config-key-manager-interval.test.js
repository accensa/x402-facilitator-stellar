/**
 * KEY_MANAGER_POLL_INTERVAL_MS validation (#664).
 *
 * Both the testnet read and the pubnet read (with its fallback to the shared
 * variable) used a bare `Number()`, which turned `5s` into `NaN` and handed it
 * to `setInterval`. These tests pin the shared integer policy instead: absent
 * or blank takes the disabled default, `0` disables polling, and anything that
 * is not a non-negative safe integer refuses at boot naming the variable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, TESTNET, PUBNET } from '../src/config.js';

// Valid ed25519 seeds: resolveConfig checks every signer secret with StrKey.
const SECRET_1 = 'SAO2MAIQCR5T27QDICO3QJTD2YZ4PMEAVLCLQ6AANVGPCZ53TEACPDOQ';
const SECRET_2 = 'SDKL5BFVNLUCIP64CY3ZXSEAOQYJ7YNG35OKBFUW5QEZNZRKV6Q5DER6';

function withPubnet(extra = {}) {
  return {
    FACILITATOR_SECRET: SECRET_1,
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: SECRET_2,
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
    ...extra,
  };
}

test('testnet: a positive integer resolves as the polling interval', () => {
  const config = resolveConfig({
    FACILITATOR_SECRET: SECRET_1,
    KEY_MANAGER_POLL_INTERVAL_MS: '30000',
  });

  assert.strictEqual(config.perNetwork[TESTNET].keyManagerPollIntervalMs, 30000);
});

test('pubnet: a positive integer resolves as the polling interval', () => {
  const config = resolveConfig(withPubnet({ KEY_MANAGER_POLL_INTERVAL_MS_PUBNET: '30000' }));

  assert.strictEqual(config.perNetwork[PUBNET].keyManagerPollIntervalMs, 30000);
});

test('zero disables polling on both networks', () => {
  const config = resolveConfig(
    withPubnet({
      KEY_MANAGER_POLL_INTERVAL_MS: '0',
      KEY_MANAGER_POLL_INTERVAL_MS_PUBNET: '0',
    }),
  );

  assert.strictEqual(config.perNetwork[TESTNET].keyManagerPollIntervalMs, 0);
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerPollIntervalMs, 0);
});

test('an unset value keeps polling disabled on both networks', () => {
  const config = resolveConfig(withPubnet());

  assert.strictEqual(config.perNetwork[TESTNET].keyManagerPollIntervalMs, 0);
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerPollIntervalMs, 0);
});

test('pubnet falls back to KEY_MANAGER_POLL_INTERVAL_MS when its own is unset', () => {
  const config = resolveConfig(withPubnet({ KEY_MANAGER_POLL_INTERVAL_MS: '30000' }));

  assert.strictEqual(config.perNetwork[TESTNET].keyManagerPollIntervalMs, 30000);
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerPollIntervalMs, 30000);
});

test('pubnet prefers its own value over the shared fallback', () => {
  const config = resolveConfig(
    withPubnet({
      KEY_MANAGER_POLL_INTERVAL_MS: '30000',
      KEY_MANAGER_POLL_INTERVAL_MS_PUBNET: '45000',
    }),
  );

  assert.strictEqual(config.perNetwork[TESTNET].keyManagerPollIntervalMs, 30000);
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerPollIntervalMs, 45000);
});

test('testnet: "5s" is rejected naming KEY_MANAGER_POLL_INTERVAL_MS', () => {
  assert.throws(
    () => resolveConfig({ FACILITATOR_SECRET: SECRET_1, KEY_MANAGER_POLL_INTERVAL_MS: '5s' }),
    /KEY_MANAGER_POLL_INTERVAL_MS must be a finite integer between 0 and .*got "5s"/,
  );
});

test('pubnet: "5s" is rejected naming the pubnet variable', () => {
  assert.throws(
    () => resolveConfig(withPubnet({ KEY_MANAGER_POLL_INTERVAL_MS_PUBNET: '5s' })),
    /KEY_MANAGER_POLL_INTERVAL_MS_PUBNET must be a finite integer between 0 and .*got "5s"/,
  );
});

test('negative values are rejected on both networks', () => {
  assert.throws(
    () => resolveConfig({ FACILITATOR_SECRET: SECRET_1, KEY_MANAGER_POLL_INTERVAL_MS: '-1' }),
    /KEY_MANAGER_POLL_INTERVAL_MS must be a finite integer between 0 and .*got "-1"/,
  );
  assert.throws(
    () => resolveConfig(withPubnet({ KEY_MANAGER_POLL_INTERVAL_MS_PUBNET: '-1' })),
    /KEY_MANAGER_POLL_INTERVAL_MS_PUBNET must be a finite integer between 0 and .*got "-1"/,
  );
});

test('decimal values are rejected on both networks', () => {
  assert.throws(
    () => resolveConfig({ FACILITATOR_SECRET: SECRET_1, KEY_MANAGER_POLL_INTERVAL_MS: '12.5' }),
    /KEY_MANAGER_POLL_INTERVAL_MS must be a finite integer between 0 and .*got "12.5"/,
  );
  assert.throws(
    () => resolveConfig(withPubnet({ KEY_MANAGER_POLL_INTERVAL_MS_PUBNET: '12.5' })),
    /KEY_MANAGER_POLL_INTERVAL_MS_PUBNET must be a finite integer between 0 and .*got "12.5"/,
  );
});

test('NaN and other non-numeric strings are rejected', () => {
  for (const value of ['NaN', 'abc', ' 30000 ', '1e3']) {
    assert.throws(
      () => resolveConfig({ FACILITATOR_SECRET: SECRET_1, KEY_MANAGER_POLL_INTERVAL_MS: value }),
      /KEY_MANAGER_POLL_INTERVAL_MS must be a finite integer between 0 and/,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test('a blank value keeps the disabled default', () => {
  const config = resolveConfig({
    FACILITATOR_SECRET: SECRET_1,
    KEY_MANAGER_POLL_INTERVAL_MS: '',
  });

  assert.strictEqual(config.perNetwork[TESTNET].keyManagerPollIntervalMs, 0);
});
