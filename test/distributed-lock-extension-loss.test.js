/**
 * Lock-loss hard cancellation (#728).
 *
 * A Redlock holder that cannot extend its TTL has lost mutual exclusion. The
 * wrapped operation must not be reported as successful just because it ignored
 * the abort signal: withRedlock races the operation against an abort promise
 * and rejects with LockLostError. These tests exercise that race with an
 * in-memory fake of the Redis script protocol, where extension deliberately
 * loses the quorum.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDistributedLock, LockLostError } from '../src/distributed-lock.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fake Redis master speaking just enough of the redlock Lua protocol:
 * evalsha fails with NOSCRIPT (forcing eval), eval implements acquire and
 * release, and extension either renews the TTL or — when failExtend is set —
 * loses the quorum on every node.
 */
function fakeNode({ failExtend = false, extendCalls } = {}) {
  const locks = new Map();
  return {
    status: 'ready',
    async evalsha() {
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    },
    async eval(script, _numKeys, args) {
      const [key, value, ttl] = args;
      const now = Date.now();
      const current = locks.get(key);
      const expired = !current || current.expireAt <= now;

      if (script.includes('"exists"')) {
        if (!expired) return 0;
        locks.set(key, { value, expireAt: now + Number(ttl) });
        return 1;
      }
      if (script.includes('del')) {
        if (current && !expired && current.value === value) locks.delete(key);
        return 1;
      }

      if (extendCalls) extendCalls.count++;
      if (failExtend) return 0;
      if (current && !expired && current.value === value) {
        current.expireAt = now + Number(ttl);
        return 1;
      }
      return 0;
    },
    async quit() {},
  };
}

function build({ failExtend = false, extendCalls } = {}) {
  const nodes = Array.from({ length: 3 }, () => fakeNode({ failExtend, extendCalls }));
  const warns = [];
  const lock = createDistributedLock({
    nodes: ['redis://n1', 'redis://n2', 'redis://n3'],
    ttlMs: 300,
    acquireTimeoutMs: 1000,
    retryDelayMs: 10,
    createClient: urls => urls.map((_, i) => nodes[i]),
    warn: m => warns.push(m),
  });
  return { lock, warns };
}

describe('withRedlock hard cancellation on lock extension loss', () => {
  test('rejects with LockLostError when an uncooperative fn ignores the signal', async () => {
    const { lock, warns } = build({ failExtend: true });
    const gate = deferred();
    let fnStarted = false;

    const operation = lock.withLock('settle:lost', async () => {
      fnStarted = true;
      // Deliberately ignores the abort signal and keeps running.
      await gate.promise;
      return 'unprotected-result';
    });

    await assert.rejects(operation, err => {
      assert.ok(err instanceof LockLostError);
      assert.equal(err.name, 'LockLostError');
      assert.equal(err.key, 'settle:lost');
      assert.match(err.message, /settle:lost/);
      assert.match(err.message, /mutual exclusion was lost/);
      return true;
    });

    assert.equal(fnStarted, true);
    assert.ok(
      warns.some(m => m.includes('lost lock "settle:lost" during extension')),
      'the extension failure must be logged',
    );

    // Let the abandoned operation finish so it cannot leak into the next test.
    gate.resolve();
    await lock.quit();
  });

  test('resolves a normal fn and clears the extension timer', async () => {
    const extendCalls = { count: 0 };
    const { lock } = build({ extendCalls });

    const result = await lock.withLock('settle:normal', async () => 'expected-value');
    assert.equal(result, 'expected-value');

    // The extension interval is >= 1s; wait past it to prove it was cleared
    // rather than left to fire against a released lock.
    await sleep(1200);
    assert.equal(extendCalls.count, 0, 'no extension should run after fn resolves');

    await lock.quit();
  });

  test('a late rejection from an uncooperative fn is handled, not unhandled', async () => {
    const { lock } = build({ failExtend: true });
    const gate = deferred();
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const operation = lock.withLock('settle:late-reject', async () => {
        await gate.promise;
        throw new Error('late failure after the lock was lost');
      });

      await assert.rejects(operation, LockLostError);

      // The lock is already lost and withRedlock has rejected. Now make fn
      // reject: the attached catch must keep this off the unhandled channel.
      gate.reject(new Error('late failure after the lock was lost'));
      await sleep(50);

      assert.deepEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      await lock.quit();
    }
  });
});
