/**
 * @file settle-side-effect-failures.test.js
 * @description Pins the money-safety guarantee on POST /settle: after funds have
 * moved and the record is persisted, the webhook enqueue and idempotency.complete
 * are wrapped in try/catch pairs that only console.error, so a failure there must
 * never turn a settled payment into a failed HTTP response or overwrite the
 * durable 'settled' record with 'failed'. A settlementStore.save failure before
 * the scheme call must produce a settle-shaped body and never call the scheme.
 * A settlementStore.updateState failure on the error path must still produce a
 * settle-shaped body rather than a bare transport error.
 *
 * Every collaborator that fails is injected through `serve()`/`withApp()`; nothing
 * here reaches the network or a funded account.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, testConfig, stubFacilitator, VALID_BODY, captureAudit } from './helpers/app.js';
import { MemorySettlementStore } from '../src/store/memory.js';

const NETWORK = 'stellar:testnet';

/** Boots the app over a failing collaborator and POSTs a single settle. */
async function postSettle({
  facilitator = stubFacilitator(),
  settlementStore,
  idempotency,
  webhooks,
  audit,
  body = VALID_BODY,
}) {
  const app = await serve({
    config: testConfig(),
    facilitator,
    idempotency,
    webhooks,
    extras: { settlementStore, audit },
  });
  try {
    const res = await app.post('/settle', body, { 'idempotency-key': 'key-1' });
    return { status: res.status, body: await res.json() };
  } finally {
    await app.close();
  }
}

describe('POST /settle side-effect failures', () => {
  test('(1) a throwing webhooks.enqueue keeps 200, success and the settled record', async () => {
    const settlementStore = new MemorySettlementStore();
    const webhooks = {
      enqueue: () => {
        throw new Error('webhook enqueue exploded');
      },
    };
    const { status, body } = await postSettle({ settlementStore, webhooks });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.transaction, 'abc123');
    assert.equal(body.network, NETWORK);
    const record = await settlementStore.get('key-1');
    assert.equal(record.state, 'settled');
  });

  test('(2) a rejecting idempotency.complete keeps 200, success and still audits the settlement', async () => {
    const settlementStore = new MemorySettlementStore();
    const idempotency = {
      keyFor: () => 'idem-1',
      begin: async () => ({ replayed: false, key: 'idem-1' }),
      complete: async () => {
        throw new Error('idempotency.complete exploded');
      },
    };
    const { audit, records } = captureAudit();
    const { status, body } = await postSettle({ settlementStore, idempotency, audit });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.transaction, 'abc123');
    assert.equal(body.network, NETWORK);
    assert.ok(
      records.some(record => record.event === 'settlement' && record.outcome === 'settled'),
      'the settlement audit record is still emitted even though idempotency.complete rejected',
    );
    const record = await settlementStore.get('key-1');
    assert.equal(record.state, 'settled');
  });

  test('(3) a settlementStore.save failure before the scheme call answers settle-shaped 500 and never calls the scheme', async () => {
    const settlementStore = new MemorySettlementStore();
    settlementStore.save = async () => {
      throw new Error('settlementStore.save exploded');
    };
    const calls = [];
    const facilitator = {
      ...stubFacilitator(),
      settle: async () => {
        calls.push('settle');
        return stubFacilitator().settle();
      },
    };
    const { status, body } = await postSettle({ facilitator, settlementStore });
    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.ok(body.errorReason);
    assert.equal(body.transaction, '');
    assert.equal(body.network, NETWORK);
    assert.equal(
      calls.length,
      0,
      'facilitator.settle must never be called when the ledger record cannot be written',
    );
  });

  test('(4) a settlementStore.updateState failure on the error path still answers settle-shaped', async () => {
    const settlementStore = new MemorySettlementStore();
    settlementStore.updateState = async () => {
      throw new Error('settlementStore.updateState exploded');
    };
    const facilitator = stubFacilitator({
      settle: async () => {
        throw new Error('scheme exploded');
      },
    });
    const { status, body } = await postSettle({ facilitator, settlementStore });
    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.ok(body.errorReason);
    assert.equal(body.transaction, '');
    assert.equal(body.network, NETWORK);
    // The body is settle-shaped (success:false + errorReason + transaction + network),
    // so an x402 client can parse it, but the HTTP status is 500: a transport error.
    // The x402 flow expects success:false in a 200 body rather than a transport error,
    // so a 500 status is not what an integrator strictly needs — the client may treat
    // non-200 as a connection failure before it ever parses the settle body.
  });
});
