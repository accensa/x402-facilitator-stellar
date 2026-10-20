/**
 * In-flight idempotency conflicts (#408).
 *
 * A duplicate that arrives while the first settlement is still running must be
 * answered with 409, not a second settlement and not an outcome-unknown 200.
 * A duplicate that arrives after completion replays the recorded response and
 * carries Idempotency-Replay: true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryIdempotencyStore } from '../src/idempotency.js';
import { serve, testConfig, stubFacilitator, stubCatalog, VALID_BODY } from './helpers/app.js';

/** A settlement store that never short-circuits, so the idempotency path runs. */
const emptySettlementStore = {
  deriveIdempotencyKey: () => 'key',
  get: async () => null,
  save: async () => {},
  updateState: async () => {},
  settleAndEnqueue: async () => ({ atomicallyEnqueued: true, event: null }),
};

test('a pending claim reports a conflict instead of a second claim', async () => {
  const store = new MemoryIdempotencyStore();
  const first = await store.begin('same');
  assert.equal(first.replayed, false);
  assert.equal(first.conflict, undefined);

  const second = await store.begin('same');
  assert.equal(second.conflict, true);
});

test('fail() releases a claim so a pre-submission retry can try again', async () => {
  const store = new MemoryIdempotencyStore();
  await store.begin('retry');
  await store.fail('retry');
  assert.equal((await store.begin('retry')).conflict, undefined);
});

test('/settle answers a concurrent duplicate with 409', async () => {
  const idempotency = new MemoryIdempotencyStore();
  await idempotency.begin('idem-conflict');

  const instance = await serve({
    config: testConfig(),
    facilitator: stubFacilitator(),
    catalog: stubCatalog(),
    idempotency,
    extras: { settlementStore: emptySettlementStore },
  });
  try {
    const res = await instance.post('/settle', VALID_BODY, {
      'idempotency-key': 'idem-conflict',
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.errorReason, 'idempotency_conflict');
  } finally {
    await instance.close();
  }
});

test('/settle replays a completed key with Idempotency-Replay: true', async () => {
  const idempotency = new MemoryIdempotencyStore();
  const first = await idempotency.begin('idem-done');
  await idempotency.complete(first.key, 200, {
    success: true,
    transaction: 'earlier',
    network: 'stellar:testnet',
  });

  const instance = await serve({
    config: testConfig(),
    facilitator: stubFacilitator(),
    catalog: stubCatalog(),
    idempotency,
    extras: { settlementStore: emptySettlementStore },
  });
  try {
    const res = await instance.post('/settle', VALID_BODY, { 'idempotency-key': 'idem-done' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('idempotency-replay'), 'true');
    assert.equal((await res.json()).transaction, 'earlier');
  } finally {
    await instance.close();
  }
});
