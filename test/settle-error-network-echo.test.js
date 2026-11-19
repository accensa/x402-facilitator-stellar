import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app.js';
import { resolveConfig } from '../src/config.js';

describe('Issue #655: /settle 400 body network echo bounds', () => {
  let app;

  before(async () => {
    const config = resolveConfig({
      FACILITATOR_SECRET: Keypair.random().secret(),
    });
    const facilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: 'tx123' }),
      getSupported: () => ({ kinds: [] }),
    };
    const rateLimiter = {
      checkVerify: async () => ({ allowed: true }),
      recordVerify: async () => {},
      checkSettle: async () => ({ allowed: true }),
      recordSettle: async () => {},
    };
    app = await createApp(config, facilitator, rateLimiter, {});
  });

  after(async () => {
    if (app) await app.close();
  });

  async function postSettleWithNetwork(networkValue) {
    const payload = {
      paymentPayload: 'not-an-object', // triggers invalid_request 400
      paymentRequirements: {
        scheme: 'exact',
        network: networkValue,
      },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      payload,
    });
    assert.equal(res.statusCode, 400);
    return JSON.parse(res.payload);
  }

  test('echoes network when network is a valid CAIP-2 id (<= 64 chars)', async () => {
    const json = await postSettleWithNetwork('stellar:testnet');
    assert.equal(json.success, false);
    assert.equal(json.errorReason, 'invalid_request');
    assert.equal(json.transaction, '');
    assert.ok(Object.prototype.hasOwnProperty.call(json, 'network'));
    assert.equal(json.network, 'stellar:testnet');
  });

  test('echoes network when network is an empty string (length 0 <= 64)', async () => {
    const json = await postSettleWithNetwork('');
    assert.equal(json.success, false);
    assert.equal(json.transaction, '');
    assert.ok(Object.prototype.hasOwnProperty.call(json, 'network'));
    assert.equal(json.network, '');
  });

  test('echoes network when network is exactly 64 characters long', async () => {
    const net64 = 'a'.repeat(64);
    const json = await postSettleWithNetwork(net64);
    assert.equal(json.success, false);
    assert.equal(json.transaction, '');
    assert.ok(Object.prototype.hasOwnProperty.call(json, 'network'));
    assert.equal(json.network, net64);
  });

  test('omits network when network is 65 characters long (> 64)', async () => {
    const net65 = 'a'.repeat(65);
    const json = await postSettleWithNetwork(net65);
    assert.equal(json.success, false);
    assert.equal(json.transaction, '');
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'network'), false);
    assert.equal(json.network, undefined);
  });

  test('omits network when network is a huge string (> 64 chars)', async () => {
    const huge = 'stellar:pubnet:' + 'x'.repeat(1000);
    const json = await postSettleWithNetwork(huge);
    assert.equal(json.success, false);
    assert.equal(json.transaction, '');
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'network'), false);
    assert.equal(json.network, undefined);
  });

  test('omits network when network is an object', async () => {
    const json = await postSettleWithNetwork({ nested: 'object' });
    assert.equal(json.success, false);
    assert.equal(json.transaction, '');
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'network'), false);
    assert.equal(json.network, undefined);
  });

  test('omits network when network is a number', async () => {
    const json = await postSettleWithNetwork(12345);
    assert.equal(json.success, false);
    assert.equal(json.transaction, '');
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'network'), false);
    assert.equal(json.network, undefined);
  });

  test('omits network when network is null', async () => {
    const json = await postSettleWithNetwork(null);
    assert.equal(json.success, false);
    assert.equal(json.transaction, '');
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'network'), false);
    assert.equal(json.network, undefined);
  });

  test('omits network when paymentRequirements is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: {
        paymentPayload: 'not-an-object',
      },
    });
    assert.equal(res.statusCode, 400);
    const json = JSON.parse(res.payload);
    assert.equal(json.success, false);
    assert.equal(json.transaction, '');
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'network'), false);
    assert.equal(json.network, undefined);
  });
});
