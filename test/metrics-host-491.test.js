import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { resolveConfig } from '../src/config.js';

function baseEnv(overrides = {}) {
  return { FACILITATOR_SECRET: Keypair.random().secret(), ...overrides };
}

test('metrics bind address defaults to loopback, not a wildcard (#491, src/server.js:356)', () => {
  const config = resolveConfig(baseEnv());
  assert.equal(config.metricsHost, '127.0.0.1');
  assert.notEqual(config.metricsHost, '0.0.0.0');
  assert.notEqual(config.metricsHost, '::');
});

test('METRICS_HOST is configurable via the existing config path (#491)', () => {
  const config = resolveConfig(baseEnv({ METRICS_HOST: '10.0.0.5' }));
  assert.equal(config.metricsHost, '10.0.0.5');
  const wildcard = resolveConfig(baseEnv({ METRICS_HOST: '0.0.0.0' }));
  assert.equal(wildcard.metricsHost, '0.0.0.0');
});
