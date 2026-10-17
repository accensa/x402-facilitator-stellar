import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, stubFacilitator, VALID_BODY, withApp } from './helpers/app.js';
import { MemorySettlementStore } from '../src/store/memory.js';

describe('POST /settle replay scoping by owning caller', () => {
  const config = testConfig({
    apiKeys: [
      'callerA:secretA-0123456789abcdefghijklmnopqrstuvwxyz',
      'callerB:secretB-0123456789abcdefghijklmnopqrstuvwxyz',
    ],
  });
  const aliceHeaders = {
    authorization: 'Bearer secretA-0123456789abcdefghijklmnopqrstuvwxyz',
  };
  const bobHeaders = {
    authorization: 'Bearer secretB-0123456789abcdefghijklmnopqrstuvwxyz',
  };

  test("caller B cannot read caller A's settled response under the same idempotency key", async () => {
    const settlementStore = new MemorySettlementStore();
    let settleCalls = 0;
    const facilitator = stubFacilitator({
      settle: async () => {
        settleCalls += 1;
        return { success: true, transaction: `tx-${settleCalls}`, network: 'stellar:testnet' };
      },
    });

    await withApp({ config, facilitator, extras: { settlementStore } }, async app => {
      // Caller A settles with header k1
      const resA = await app.post('/settle', VALID_BODY, {
        ...aliceHeaders,
        'idempotency-key': 'k1',
      });
      assert.equal(resA.status, 200);
      const jsonA = await resA.json();
      assert.equal(jsonA.success, true);
      assert.equal(jsonA.transaction, 'tx-1');

      // Caller B posts with the same header k1 — must NOT receive A's response.
      // B's tenant-safe store key differs from A's, so B gets a fresh settlement.
      const resB = await app.post('/settle', VALID_BODY, {
        ...bobHeaders,
        'idempotency-key': 'k1',
      });
      assert.equal(resB.status, 200);
      const jsonB = await resB.json();
      assert.equal(jsonB.success, true);
      assert.notEqual(jsonB.transaction, jsonA.transaction, "B must not receive A's transaction");
      assert.equal(settleCalls, 2, "B's payment must be attempted, not replayed");
    });
  });

  test("caller B with no idempotency header does not read caller A's record", async () => {
    const settlementStore = new MemorySettlementStore();
    let settleCalls = 0;
    const facilitator = stubFacilitator({
      settle: async () => {
        settleCalls += 1;
        return { success: true, transaction: `tx-${settleCalls}`, network: 'stellar:testnet' };
      },
    });

    await withApp({ config, facilitator, extras: { settlementStore } }, async app => {
      // Caller A settles with header k1
      const resA = await app.post('/settle', VALID_BODY, {
        ...aliceHeaders,
        'idempotency-key': 'k1',
      });
      assert.equal(resA.status, 200);
      const jsonA = await resA.json();
      assert.equal(jsonA.transaction, 'tx-1');

      // Caller B with the same payload but no Idempotency-Key header.
      // B's derived key is payload-hash based and namespaced to callerB,
      // so it cannot collide with A's callerA:k1 record.
      const resB = await app.post('/settle', VALID_BODY, bobHeaders);
      assert.equal(resB.status, 200);
      const jsonB = await resB.json();
      assert.equal(jsonB.success, true);
      assert.notEqual(jsonB.transaction, jsonA.transaction, "B must not read A's record");
      assert.equal(settleCalls, 2, "B's payment must be attempted, not replayed");
    });
  });

  test('caller A retrying its own idempotency key replays the stored response', async () => {
    const settlementStore = new MemorySettlementStore();
    let settleCalls = 0;
    const facilitator = stubFacilitator({
      settle: async () => {
        settleCalls += 1;
        return { success: true, transaction: `tx-${settleCalls}`, network: 'stellar:testnet' };
      },
    });

    await withApp({ config, facilitator, extras: { settlementStore } }, async app => {
      // Caller A settles with header k1
      const resA1 = await app.post('/settle', VALID_BODY, {
        ...aliceHeaders,
        'idempotency-key': 'k1',
      });
      assert.equal(resA1.status, 200);
      const jsonA1 = await resA1.json();
      assert.equal(jsonA1.transaction, 'tx-1');

      // Caller A retries with the same header — must replay exactly as before
      const resA2 = await app.post('/settle', VALID_BODY, {
        ...aliceHeaders,
        'idempotency-key': 'k1',
      });
      assert.equal(resA2.status, 200);
      const jsonA2 = await resA2.json();
      assert.deepEqual(jsonA2, jsonA1, 'same-caller replay must return the stored response');
      assert.equal(settleCalls, 1, 'scheme settle must not run again on replay');
    });
  });

  test('a pre-existing record with a different key_id is not replayed to another caller', async () => {
    const settlementStore = new MemorySettlementStore();
    // Simulate a record written before the change: owned by callerA under key k1
    await settlementStore.save({
      idempotency_key: 'callerA:k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'settled',
      tx_hash: 'tx-preexisting',
      key_id: 'callerA',
    });
    let settleCalls = 0;
    const facilitator = stubFacilitator({
      settle: async () => {
        settleCalls += 1;
        return { success: true, transaction: `tx-${settleCalls}`, network: 'stellar:testnet' };
      },
    });

    await withApp({ config, facilitator, extras: { settlementStore } }, async app => {
      // Caller B posts with header k1 — the pre-existing record belongs to callerA
      const resB = await app.post('/settle', VALID_BODY, {
        ...bobHeaders,
        'idempotency-key': 'k1',
      });
      assert.equal(resB.status, 200);
      const jsonB = await resB.json();
      assert.equal(jsonB.success, true);
      assert.notEqual(
        jsonB.transaction,
        'tx-preexisting',
        "B must not read A's pre-existing record",
      );
      assert.equal(settleCalls, 1, "B's payment must be attempted");
    });
  });
});
