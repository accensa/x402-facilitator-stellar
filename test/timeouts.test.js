import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app.js';
import { resolveConfig } from '../src/config.js';
import { requestState } from '../src/request-state.js';

describe('Request Timeouts (#8)', () => {
  const baseConfig = resolveConfig({
    FACILITATOR_SECRET: Keypair.random().secret(),
    REQUEST_TIMEOUT_MS: '50',
  });

  test('/verify times out and returns request_timeout reason', async () => {
    const slowFacilitator = {
      verify: () => new Promise(resolve => setTimeout(resolve, 200)),
      settle: async () => ({}),
      getSupported: () => ({}),
    };
    const rateLimiter = {
      checkVerify: async () => ({ allowed: true }),
      recordVerify: async () => {},
      checkSettle: async () => ({ allowed: true }),
      recordSettle: async () => {},
    };

    const app = await createApp(baseConfig, slowFacilitator, rateLimiter, {});
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: {
          paymentPayload: { transaction: 'AAAA' },
          paymentRequirements: { scheme: 'exact', network: 'stellar:testnet' },
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'request_timeout');
    } finally {
      await app.close();
    }
  });

  test('/settle times out before submission and returns request_timeout reason', async () => {
    const slowFacilitator = {
      verify: async () => ({}),
      settle: () => new Promise(resolve => setTimeout(resolve, 200)),
      getSupported: () => ({}),
    };
    const rateLimiter = {
      checkVerify: async () => ({ allowed: true }),
      recordVerify: async () => {},
      checkSettle: async () => ({ allowed: true }),
      recordSettle: async () => {},
    };

    const app = await createApp(baseConfig, slowFacilitator, rateLimiter, {});
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/settle',
        payload: {
          paymentPayload: { transaction: 'AAAA' },
          paymentRequirements: { scheme: 'exact', network: 'stellar:testnet' },
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.success, false);
      assert.equal(body.errorReason, 'request_timeout');
    } finally {
      await app.close();
    }
  });

  test('/settle times out after submission and returns submitted_outcome_unknown', async () => {
    const slowFacilitatorAfterSubmit = {
      verify: async () => ({}),
      settle: () =>
        new Promise(resolve => {
          const store = requestState.getStore();
          if (store) store.submitted = true;
          setTimeout(resolve, 200);
        }),
      getSupported: () => ({}),
    };
    const rateLimiter = {
      checkVerify: async () => ({ allowed: true }),
      recordVerify: async () => {},
      checkSettle: async () => ({ allowed: true }),
      recordSettle: async () => {},
    };

    const app = await createApp(baseConfig, slowFacilitatorAfterSubmit, rateLimiter, {});
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/settle',
        payload: {
          paymentPayload: { transaction: 'HASH123' },
          paymentRequirements: { scheme: 'exact', network: 'stellar:testnet' },
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.success, false);
      assert.equal(body.errorReason, 'submitted_outcome_unknown');
      assert.equal(body.transaction, 'HASH123');
    } finally {
      await app.close();
    }
  });
});
