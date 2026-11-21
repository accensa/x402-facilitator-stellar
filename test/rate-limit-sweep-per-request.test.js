/**
 * Issue #714: per-request sweeps must be gone from the hot path.
 *
 * Every rate-limit check used to call `store.sweep` inline (`await`ed in
 * `_check`), so a high-throughput settlement path swept the whole bucket
 * store once per check — the per-minute, per-hour and per-day settle checks
 * of `checkSettle` meant four synchronous full-store sweeps per settlement.
 * Pruning is now the job of the constructor's 60-second background timer;
 * this file pins both halves: checks never sweep, and the timer (plus an
 * explicit `_sweep`) still does.
 *
 * Testing strategy: a spy store records every `store.sweep` call while
 * delegating to a real MemoryStore, so the assertions prove the checks ran
 * (store.get calls) while asserting none of them swept. Mock timers drive
 * the interval the way test/rate-limit.test.js does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { MemoryStore } from '../src/rate-limit-store.js';

const LIMITS = {
  global: {
    verifyRpm: 10,
    settleRpm: 10,
    settleRph: 10,
    settleRpd: 10,
    feeSpd: 500000,
    catalogRpm: 10,
    catalogReadRpm: 60,
  },
  keys: {},
};

/**
 * A MemoryStore-backed spy: `sweep` records its `now` argument before
 * delegating, `get` counts calls, so a test can prove the checks ran while
 * asserting that none of them swept.
 *
 * @returns {{store: object, inner: MemoryStore, state: {gets: number, sweeps: number[]}}}
 */
function spyStore() {
  const inner = new MemoryStore();
  const state = { gets: 0, sweeps: [] };
  return {
    inner,
    state,
    store: {
      get: async (...args) => {
        state.gets += 1;
        return inner.get(...args);
      },
      increment: async (...args) => inner.increment(...args),
      sweep: async now => {
        state.sweeps.push(now);
        return inner.sweep(now);
      },
    },
  };
}

/**
 * @param {import('node:test').TestContext} t - the running test, for teardown
 * @param {object} store - the spy or real store to give the limiter
 * @returns {RateLimiter}
 */
function newLimiter(t, store) {
  const limiter = new RateLimiter(LIMITS, store);
  t.after(() => limiter.close());
  return limiter;
}

test('rate-limit checks do not sweep the store per request', async t => {
  const { store, state } = spyStore();
  const limiter = newLimiter(t, store);
  const req = { keyId: 'K' };

  assert.equal((await limiter.checkVerify(req)).allowed, true);
  const afterVerify = state.gets;
  assert.ok(afterVerify > 0, 'checkVerify must read the store for this to prove anything');

  // checkSettle runs four _check calls: per-minute, per-hour, per-day settle
  // and the fee-ceiling check.
  assert.equal((await limiter.checkSettle(req)).allowed, true);
  assert.equal(state.gets - afterVerify, 4, 'checkSettle must run its four _check calls');

  const afterSettle = state.gets;
  assert.equal((await limiter.checkCatalog(req)).allowed, true);
  assert.ok(state.gets > afterSettle, 'checkCatalog must read the store');

  const afterCatalog = state.gets;
  assert.equal((await limiter.checkCatalogRead(req)).allowed, true);
  assert.ok(state.gets > afterCatalog, 'checkCatalogRead must read the store');

  assert.deepEqual(state.sweeps, [], 'serving checks must not call store.sweep');
});

test('explicit _sweep calls store.sweep and still prunes expired buckets', async t => {
  const { store, inner, state } = spyStore();
  const limiter = newLimiter(t, store);
  const now = Math.floor(Date.now() / 1000);
  inner.map.set('catalog:127.0.0.1:60', { count: 5, resetAt: now - 10 });
  inner.map.set('catalog:127.0.0.2:60', { count: 5, resetAt: now + 60 });

  await limiter._sweep(now);

  assert.equal(state.sweeps.length, 1, '_sweep must delegate to store.sweep');
  assert.equal(inner.map.has('catalog:127.0.0.1:60'), false, 'the expired bucket must be pruned');
  assert.equal(inner.map.has('catalog:127.0.0.2:60'), true, 'the live bucket must survive');
});

test('the 60-second background timer still sweeps the store', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { store, state } = spyStore();
  newLimiter(t, store);

  t.mock.timers.tick(59_999);
  assert.equal(state.sweeps.length, 0);
  t.mock.timers.tick(1);
  assert.equal(state.sweeps.length, 1, 'the interval must sweep once per 60 seconds');
  // The sweep is told the current time in whole seconds.
  assert.ok(Number.isInteger(state.sweeps[0]));
});
