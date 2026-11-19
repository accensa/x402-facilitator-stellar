/**
 * In-process lock memory retention (#764).
 *
 * createMemoryLockManager keys its wait queue on the lock key. Settlement locks
 * use a per-payment idempotency key, so if a released key's entry stayed in the
 * tail map forever the map would grow with settlement volume until the pod ran
 * out of memory. These tests pin two properties: the map drains when a lock is
 * released with no waiters behind it, and it does not drain early while a newer
 * waiter is still queued (which would let two holders in at once).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLockManager } from '../src/distributed-lock.js';

describe('memory lock tail map cleanup', () => {
  test('drains the entry for a key once its lock is released', async () => {
    const lock = createMemoryLockManager();
    assert.equal(lock.pendingKeys, 0);

    const result = await lock.withLock('settle:one', async () => 'done');

    assert.equal(result, 'done');
    assert.equal(lock.pendingKeys, 0);
  });

  test('does not retain entries across 10,000 distinct keys', async () => {
    const lock = createMemoryLockManager();

    for (let i = 0; i < 10_000; i++) {
      await lock.withLock(`settle:${i}`, async () => i);
      // Every key is settled and released before the next one starts, so the
      // map must not remember any of them.
      assert.equal(lock.pendingKeys, 0, `key settle:${i} leaked its tail entry`);
    }
  });

  test('drains after a lock operation throws', async () => {
    const lock = createMemoryLockManager();

    await assert.rejects(
      lock.withLock('settle:throws', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.equal(lock.pendingKeys, 0);
  });

  test('keeps the entry while a newer waiter is queued, then drains', async () => {
    const lock = createMemoryLockManager();
    let releaseFirst;
    const firstHeld = new Promise(resolve => {
      releaseFirst = resolve;
    });
    let firstInside = false;

    const first = lock.withLock('settle:contended', async () => {
      firstInside = true;
      await firstHeld;
    });
    // Wait until the first holder really owns the key before queueing behind it.
    while (!firstInside) await Promise.resolve();
    assert.equal(lock.pendingKeys, 1);

    let secondRan = false;
    const second = lock.withLock('settle:contended', async () => {
      secondRan = true;
    });

    releaseFirst();
    await first;

    // The first holder released, but the second is queued: deleting the entry
    // here would let a third caller acquire the key concurrently.
    assert.equal(secondRan, false);
    assert.equal(lock.pendingKeys, 1);

    await second;

    assert.equal(secondRan, true);
    assert.equal(lock.pendingKeys, 0);
  });

  test('concurrent acquisitions on one key still run in strict FIFO order', async () => {
    const lock = createMemoryLockManager();
    const order = [];

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        lock.withLock('settle:fifo', async () => {
          order.push(i);
          // Yield so an out-of-order holder would be visible if one existed.
          await new Promise(resolve => setTimeout(resolve, 0));
        }),
      ),
    );

    assert.deepEqual(
      order,
      Array.from({ length: 25 }, (_, i) => i),
    );
    assert.equal(lock.pendingKeys, 0);
  });

  test('a new lock on a reused key is not deleted by the previous release', async () => {
    const lock = createMemoryLockManager();

    await lock.withLock('settle:reused', async () => {});

    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        lock.withLock('settle:reused', async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await new Promise(resolve => setTimeout(resolve, 5));
          inside--;
        }),
      ),
    );

    assert.equal(maxInside, 1);
    assert.equal(lock.pendingKeys, 0);
  });
});
