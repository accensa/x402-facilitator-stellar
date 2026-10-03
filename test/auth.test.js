import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';
import { Keypair } from '@stellar/stellar-sdk';

test('auth config resolution handles open mode', () => {
  const env = { FACILITATOR_SECRET: Keypair.random().secret() };
  const config = resolveConfig(env);
  assert.equal(config.apiKeys.length, 0);
});

test('auth config resolves plain keys to hashes with auto-generated ids', () => {
  const env = {
    FACILITATOR_SECRET: Keypair.random().secret(),
    FACILITATOR_API_KEYS:
      'secret1-0123456789abcdefghijklmnopqrstuvwxyz, secret2-0123456789abcdefghijklmnopqrstuvwxyz',
  };
  const config = resolveConfig(env);
  assert.equal(config.apiKeys.length, 2);
  assert.equal(config.apiKeys[0].id, 'key_0');
  assert.ok(Buffer.isBuffer(config.apiKeys[0].hash));
  assert.equal(config.apiKeys[1].id, 'key_1');
});

test('auth config resolves named keys', () => {
  const env = {
    FACILITATOR_SECRET: Keypair.random().secret(),
    FACILITATOR_API_KEYS:
      'admin:supersecret-0123456789abcdefghijklmnopqrstuvwxyz,agent:agentsecret-0123456789abcdefghijklmnopqrstuvwxyz',
  };
  const config = resolveConfig(env);
  assert.equal(config.apiKeys.length, 2);
  assert.equal(config.apiKeys[0].id, 'admin');
  assert.equal(config.apiKeys[1].id, 'agent');
});
