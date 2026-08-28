import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { MemorySettlementStore } from '../src/store/memory.js';
import { buildSettlementStore } from '../src/store/index.js';
import { reconcileUnknownSettlements } from '../src/store/reconciliation.js';
import { createApp } from '../src/app.js';
import { resolveConfig } from '../src/config.js';

describe('Durable Settlement Store & Idempotency Keys (#10)', () => {
  test('idempotency key derivation prefers header when present', () => {
    const store = new MemorySettlementStore();
    const req = {
      headers: { 'idempotency-key': ' custom-key-123 ' },
      body: { paymentPayload: { transaction: 'AAAA...' } },
    };
    assert.equal(store.deriveIdempotencyKey(req), 'custom-key-123');
  });

  test('idempotency key derivation is deterministic and collision resistant', () => {
    const store = new MemorySettlementStore();
    const req1 = { body: { paymentPayload: { transaction: 'AAAA_TX_1' } } };
    const req2 = { body: { paymentPayload: { transaction: 'AAAA_TX_1' } } };
    const req3 = { body: { paymentPayload: { transaction: 'AAAA_TX_2' } } };

    const key1 = store.deriveIdempotencyKey(req1);
    const key2 = store.deriveIdempotencyKey(req2);
    const key3 = store.deriveIdempotencyKey(req3);

    assert.equal(key1, key2);
    assert.notEqual(key1, key3);
    assert.ok(key1.startsWith('derived:'));
  });

  test('MemorySettlementStore save, updateState, and listUnknown', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'submitted',
      tx_hash: 'hash1',
    });

    const rec = await store.get('k1');
    assert.equal(rec.state, 'submitted');
    assert.equal(rec.tx_hash, 'hash1');

    await store.updateState('k1', 'unknown', { error_reason: 'submitted_outcome_unknown' });
    const unknowns = await store.listUnknown();
    assert.equal(unknowns.length, 1);
    assert.equal(unknowns[0].idempotency_key, 'k1');
    assert.equal(unknowns[0].state, 'unknown');

    await store.updateState('k1', 'settled');
    const updated = await store.get('k1');
    assert.equal(updated.state, 'settled');
    const unknownsAfter = await store.listUnknown();
    assert.equal(unknownsAfter.length, 0);
  });

  test('buildSettlementStore logs loud warning when DATABASE_URL is unset', () => {
    const warnings = [];
    const store = buildSettlementStore({}, { log: msg => warnings.push(msg) });
    assert.ok(store instanceof MemorySettlementStore);
    assert.ok(warnings.some(w => w.includes('DATABASE_URL is unset')));
  });

  test('duplicate /settle with same idempotency key replays response without touching scheme', async () => {
    let schemeCallCount = 0;
    const mockFacilitator = {
      settle: async () => {
        schemeCallCount++;
        return {
          success: true,
          transaction: 'tx_hash_123',
          network: 'stellar:testnet',
          payer: 'G_PAYER',
        };
      },
      getSupported: () => ({}),
    };

    const dummySecret = Keypair.random().secret();
    // Key ids must be alphanumeric + underscore to be usable in RATE_LIMIT_
    // env var names, so the id carries an underscore rather than a hyphen.
    const config = resolveConfig({
      FACILITATOR_SECRET: dummySecret,
      FACILITATOR_API_KEYS: 'test_key:sec123',
    });
    const mockRateLimiter = {
      checkSettle: async () => ({ allowed: true }),
      recordSettle: async () => {},
    };
    const store = new MemorySettlementStore();

    const app = createApp(config, mockFacilitator, mockRateLimiter, {}, null, {
      settlementStore: store,
    });

    try {
      const payload = {
        paymentPayload: { transaction: 'TX_XDR_DEDUPE_1' },
        paymentRequirements: { network: 'stellar:testnet', scheme: 'exact-stellar' },
      };

      const res1 = await app.inject({
        method: 'POST',
        url: '/settle',
        headers: { authorization: 'Bearer sec123' },
        payload,
      });

      assert.equal(res1.statusCode, 200);
      assert.equal(schemeCallCount, 1);

      const res2 = await app.inject({
        method: 'POST',
        url: '/settle',
        headers: { authorization: 'Bearer sec123' },
        payload,
      });

      assert.equal(res2.statusCode, 200);
      assert.equal(schemeCallCount, 1); // Scheme call count MUST NOT increment!
      const body2 = JSON.parse(res2.payload);
      assert.equal(body2.success, true);
      assert.equal(body2.transaction, 'tx_hash_123');
    } finally {
      await app.close();
    }
  });

  test('GET /settlements/:idempotencyKey is authenticated and scoped to caller keyId', async () => {
    const dummySecret = Keypair.random().secret();
    const config = resolveConfig({
      FACILITATOR_SECRET: dummySecret,
      FACILITATOR_API_KEYS: 'callerA:secretA,callerB:secretB',
    });

    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'settlement-A',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'settled',
      tx_hash: 'hashA',
      key_id: 'callerA',
    });

    const app = createApp(
      config,
      { getSupported: () => ({}) },
      { checkSettle: async () => ({ allowed: true }) },
      {},
      null,
      {
        settlementStore: store,
      },
    );

    try {
      // Caller A requests own settlement -> 200 OK
      const resA = await app.inject({
        method: 'GET',
        url: '/settlements/settlement-A',
        headers: { authorization: 'Bearer secretA' },
      });
      assert.equal(resA.statusCode, 200);
      const bodyA = JSON.parse(resA.payload);
      assert.equal(bodyA.ok, true);
      assert.equal(bodyA.settlement.tx_hash, 'hashA');

      // Caller B requests Caller A's settlement -> 404 Not Found (scoped)
      const resB = await app.inject({
        method: 'GET',
        url: '/settlements/settlement-A',
        headers: { authorization: 'Bearer secretB' },
      });
      assert.equal(resB.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  test('reconcileUnknownSettlements resolves unknown records via RPC', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'unresolved-1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });
    // Realistic path to 'unknown': submitted, then the outcome couldn't be
    // confirmed (see app.js's timeout-after-submission handling) — a
    // settlement never starts life already 'unknown' (#130).
    await store.updateState('unresolved-1', 'unknown', { tx_hash: 'tx_confirmed_123' });

    const mockRpc = async (_url, body) => {
      if (body.method === 'getTransaction' && body.params.hash === 'tx_confirmed_123') {
        return { result: { status: 'SUCCESS' } };
      }
      return { result: { status: 'NOT_FOUND' } };
    };

    const res = await reconcileUnknownSettlements(
      store,
      { perNetwork: { 'stellar:testnet': { rpcUrl: 'https://soroban-testnet.stellar.org' } } },
      { rpcCall: mockRpc },
    );

    assert.equal(res.reconciled, 1);
    const rec = await store.get('unresolved-1');
    assert.equal(rec.state, 'settled');
  });
});
