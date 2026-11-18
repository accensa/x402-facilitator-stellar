/**
 * The reconciliation loop must not overlap sweeps (#723).
 *
 * `reconcileUnknownSettlements` walks every unknown settlement and makes one
 * RPC call per transaction, each bounded by a 5s timeout. A backlog makes a
 * sweep easily longer than `intervalMs`, so a naive `setInterval` starts a
 * second concurrent sweep that doubles Soroban traffic and races
 * `store.updateState`. These tests pin the single-flight contract: an in-flight
 * sweep makes later ticks no-ops, `unref()` is reachable on the timer handle,
 * and `stop()` resolves only after the active sweep finishes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startReconciliationLoop } from '../src/store/reconciliation.js';

function fakeStore() {
  return {
    listUnknown: async () => [
      { idempotency_key: 'k-1', tx_hash: 'tx-1', network: 'stellar:testnet', state: 'unknown' },
    ],
    updateState: async () => ({ idempotency_key: 'k-1', state: 'failed' }),
    settleAndEnqueue: async () => ({ atomicallyEnqueued: false, record: null, event: null }),
  };
}

describe('reconciliation loop single-flight (#723)', () => {
  test('a slow sweep prevents overlapping execution', async () => {
    const store = fakeStore();
    let rpcInvocations = 0;
    let releaseRpc;
    const rpcStarted = new Promise(resolve => {
      releaseRpc = resolve;
    });
    let rpcFinish;
    const rpcDone = new Promise(resolve => {
      rpcFinish = resolve;
    });

    const rpcCall = async () => {
      rpcInvocations++;
      releaseRpc();
      await rpcDone;
      return { result: { status: 'FAILED' } };
    };

    const handle = startReconciliationLoop(store, {}, { intervalMs: 5, rpcCall });
    // Wait for the first sweep's RPC to start, then let several ticks elapse
    // while it is still in flight.
    await rpcStarted;
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.equal(rpcInvocations, 1, 'overlapping ticks must not start a second sweep');

    rpcFinish();
    await handle.stop();
    assert.equal(rpcInvocations, 1);
  });

  test('stop() awaits an in-flight sweep before resolving', async () => {
    const store = fakeStore();
    let releaseRpc;
    const rpcStarted = new Promise(resolve => {
      releaseRpc = resolve;
    });
    let rpcFinish;
    const rpcDone = new Promise(resolve => {
      rpcFinish = resolve;
    });
    let finished = false;

    const rpcCall = async () => {
      releaseRpc();
      await rpcDone;
      finished = true;
      return { result: { status: 'FAILED' } };
    };

    const handle = startReconciliationLoop(store, {}, { intervalMs: 5, rpcCall });
    await rpcStarted;

    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(resolved, false, 'stop() must wait for the active sweep');

    rpcFinish();
    await stopPromise;
    assert.equal(resolved, true);
    assert.equal(finished, true, 'the active sweep completed before stop() resolved');
  });

  test('after stop() no further sweeps run', async () => {
    const store = fakeStore();
    let rpcCalls = 0;
    const rpcCall = async () => {
      rpcCalls++;
      return { result: { status: 'FAILED' } };
    };

    const handle = startReconciliationLoop(store, {}, { intervalMs: 5, rpcCall });
    await new Promise(resolve => setTimeout(resolve, 30));
    await handle.stop();
    const afterStop = rpcCalls;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(rpcCalls, afterStop, 'stop() must halt further sweeps');
  });
});
