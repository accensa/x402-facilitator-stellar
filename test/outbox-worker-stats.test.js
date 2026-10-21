/**
 * Outbox worker per-cycle counts (#581).
 *
 * `pollOutboxOnce` already returns `{ claimed, published, failed }`, but the
 * handle's `tick()` dropped it, so a cycle that published nothing and one whose
 * publishes all failed looked identical to a caller or a test. This file pins
 * the handle's resolved value, including the documented empty cycle when the
 * poll throws, and that start()/stop() still behave as server.js expects.
 *
 * The outbox is an in-memory stub shaped like
 * `import('../src/outbox/store.js').OutboxStore`; only `claimBatch`,
 * `markPublished` and `markFailed` are exercised. The interval loop is never
 * started — the tests drive `tick()` directly so the suite stays offline, fast,
 * and deterministic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startOutboxWorker } from '../src/outbox/worker.js';

const row = (id, eventId) => ({
  id,
  event_id: eventId,
  type: 'settlement.completed',
  payload: { transaction: eventId },
  attempts: 0,
});

function stubOutbox(rows) {
  return {
    claimBatch: async () => rows,
    markPublished: async () => {},
    markFailed: async () => {},
    countPending: async () => 0,
  };
}

describe('outbox worker tick() counts (#581)', () => {
  test('tick() resolves with the cycle counts: 3 claimed, 2 published, 1 failed', async () => {
    const worker = startOutboxWorker({
      outbox: stubOutbox([row(1, 'e1'), row(2, 'e2'), row(3, 'e3')]),
      publish: async record => {
        if (record.id === 'e2') throw new Error('broker unreachable');
      },
      maxAttempts: 5,
      intervalMs: 60_000,
    });

    const stats = await worker.tick();
    assert.deepEqual(stats, { claimed: 3, published: 2, failed: 1 });
    await worker.stop();
  });

  test('a rejecting claimBatch still resolves with the documented empty cycle', async () => {
    const logs = [];
    const worker = startOutboxWorker({
      outbox: {
        claimBatch: async () => {
          throw new Error('db down');
        },
      },
      publish: async () => {},
      log: msg => logs.push(msg),
    });

    const stats = await worker.tick();
    assert.deepEqual(stats, { claimed: 0, published: 0, failed: 0 });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /poll failed/);
    await worker.stop();
  });

  test('a poll that throws resolves with an empty cycle and keeps the loop-error log', async () => {
    const logs = [];
    const worker = startOutboxWorker({
      // A store that resolves a non-iterable makes pollOutboxOnce throw rather
      // than handle the failure itself — the guard tick() owns.
      outbox: { claimBatch: async () => null },
      publish: async () => {},
      log: msg => logs.push(msg),
    });

    const stats = await worker.tick();
    assert.deepEqual(stats, { claimed: 0, published: 0, failed: 0 });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[Outbox\] loop error/);
    await worker.stop();
  });

  test('start()/stop() are unchanged; a stopped worker ticks an empty cycle', async () => {
    const worker = startOutboxWorker({
      outbox: stubOutbox([]),
      publish: async () => {},
      intervalMs: 60_000,
    });

    assert.equal(worker.start(), worker, 'start() still returns the handle');
    await worker.stop();
    assert.deepEqual(await worker.tick(), { claimed: 0, published: 0, failed: 0 });
  });
});
