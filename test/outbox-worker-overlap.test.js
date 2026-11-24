import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startOutboxWorker } from '../src/outbox/worker.js';

describe('outbox worker tick overlap guard', () => {
  test('skips overlapping tick when poll cycle is in flight', async () => {
    let pollCount = 0;
    let resolvePoll;

    const fakeOutbox = {
      claimBatch: async () => {
        pollCount++;
        return new Promise(resolve => {
          resolvePoll = () => resolve([]);
        });
      },
    };

    const worker = startOutboxWorker({
      intervalMs: 10,
      outbox: fakeOutbox,
      publish: async () => {},
    });

    // Start first tick (in flight)
    const tick1 = worker.tick();
    assert.equal(pollCount, 1);

    // Second tick while first is still running should skip
    const tick2Result = await worker.tick();
    assert.deepEqual(tick2Result, { claimed: 0, published: 0, failed: 0 });
    assert.equal(pollCount, 1);

    // Resolve first poll
    resolvePoll();
    const tick1Result = await tick1;
    assert.deepEqual(tick1Result, { claimed: 0, published: 0, failed: 0 });

    // Subsequent tick after completion runs normally
    const tick3 = worker.tick();
    assert.equal(pollCount, 2);
    resolvePoll();
    await tick3;
    assert.equal(pollCount, 2);
  });

  test('resets in-flight guard when poll throws', async () => {
    let shouldThrow = true;
    let pollCount = 0;

    const fakeOutbox = {
      claimBatch: async () => {
        pollCount++;
        if (shouldThrow) {
          throw new Error('database connection failed');
        }
        return [];
      },
    };

    const worker = startOutboxWorker({
      intervalMs: 10,
      outbox: fakeOutbox,
      publish: async () => {},
    });

    const res1 = await worker.tick();
    assert.deepEqual(res1, { claimed: 0, published: 0, failed: 0 });
    assert.equal(pollCount, 1);

    // Guard should be reset, second call works
    shouldThrow = false;
    const res2 = await worker.tick();
    assert.deepEqual(res2, { claimed: 0, published: 0, failed: 0 });
    assert.equal(pollCount, 2);
  });

  test('stop waits for in-flight poll to complete cleanly', async () => {
    let completed = false;
    let resolvePoll;

    const fakeOutbox = {
      claimBatch: async () => {
        return new Promise(resolve => {
          resolvePoll = () => {
            completed = true;
            resolve([]);
          };
        });
      },
    };

    const worker = startOutboxWorker({
      intervalMs: 10,
      outbox: fakeOutbox,
      publish: async () => {},
    });

    const tickPromise = worker.tick();
    assert.equal(completed, false);

    let stopResolved = false;
    const stopPromise = worker.stop().then(() => {
      stopResolved = true;
    });

    // stop() should not have resolved yet because poll is in-flight
    await new Promise(r => setTimeout(r, 20));
    assert.equal(stopResolved, false);

    // Complete the poll
    resolvePoll();
    await tickPromise;
    await stopPromise;
    assert.equal(stopResolved, true);
    assert.equal(completed, true);
  });
});
