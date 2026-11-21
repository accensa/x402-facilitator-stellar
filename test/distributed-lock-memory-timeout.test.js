/**
 * In-process lock acquire timeout (#708).
 *
 * The memory fallback chains waiters behind the previous holder's release and
 * has no expiry of its own: a lock whose holder never released wedged every
 * later acquire(key) forever. These tests pin the timeout contract: a waiter
 * that outlasts acquireTimeoutMs gets LockAcquireTimeoutError, the chain still
 * advances when the original holder releases, and normal acquisition leaves
 * no timer handles behind.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLockManager, LockAcquireTimeoutError } from '../src/distributed-lock.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const activeTimeouts = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

describe('memory lock acquire timeout (#708)', () => {
  test('rejects with LockAcquireTimeoutError when the key stays held past acquireTimeoutMs', async () => {
    const lock = createMemoryLockManager({ acquireTimeoutMs: 50 });
    const holder = await lock.acquire('settle:timeout');

    await assert.rejects(lock.acquire('settle:timeout'), err => {
      assert.ok(err instanceof LockAcquireTimeoutError);
      assert.equal(err.name, 'LockAcquireTimeoutError');
      assert.equal(err.key, 'settle:timeout');
      return true;
    });

    holder.release();
  });

  test('a waiter whose turn arrives within the deadline acquires normally', async () => {
    const lock = createMemoryLockManager({ acquireTimeoutMs: 200 });
    const holder = await lock.acquire('settle:in-time');
    const waiter = lock.acquire('settle:in-time');

    await sleep(20);
    holder.release();

    const handle = await waiter;
    assert.equal(typeof handle.release, 'function');
    handle.release();
  });

  test('releasing the original lock after a timeout lets the next acquire succeed immediately', async () => {
    const lock = createMemoryLockManager({ acquireTimeoutMs: 50 });
    const holder = await lock.acquire('settle:unblock');
    await assert.rejects(lock.acquire('settle:unblock'), LockAcquireTimeoutError);

    holder.release();
    const next = await Promise.race([lock.acquire('settle:unblock'), sleep(500).then(() => null)]);
    assert.ok(next, 'subsequent acquire must resolve once the original holder released');
    assert.equal(typeof next.release, 'function');
    next.release();
  });

  test('normal acquisition succeeds without leaking timer handles', async () => {
    const lock = createMemoryLockManager({ acquireTimeoutMs: 10_000 });
    const before = activeTimeouts();

    const handle = await lock.acquire('settle:clean');
    handle.release();
    await sleep(5);

    assert.equal(activeTimeouts(), before);
  });

  test('the timeout path emits zero unhandled promise rejections', async () => {
    const lock = createMemoryLockManager({ acquireTimeoutMs: 25 });
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const holder = await lock.acquire('settle:quiet');
      await assert.rejects(lock.acquire('settle:quiet'), LockAcquireTimeoutError);
      holder.release();
      // Give any late rejection a chance to surface.
      await sleep(50);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });
});
