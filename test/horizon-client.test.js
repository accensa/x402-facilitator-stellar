/**
 * Horizon connection pooling and circuit breaking (#120).
 *
 * The keep-alive pool itself is undici's and is exercised indirectly (the
 * dispatcher it installs must pass a dispatcher option through). What is under
 * direct test is the circuit breaker lifecycle: trip after repeated failures,
 * fail fast while open, probe while half-open, close on recovery — per origin,
 * so one degraded backend never blocks another.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  installHorizonClient,
  createFeeEstimator,
  FEE_STATS_TTL_MS,
  MIN_BASE_FEE_STROOPS,
} from '../src/horizon-client.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Installs the client with fast timings so state transitions are testable. */
function install(baseFetch) {
  const warns = [];
  const logs = [];
  const client = installHorizonClient({
    baseFetch,
    breakerTimeoutMs: 500,
    breakerErrorThreshold: 50,
    breakerResetTimeoutMs: 100,
    warn: m => warns.push(m),
    log: m => logs.push(m),
  });
  return { client, warns, logs };
}

describe('circuit breaker', () => {
  test('trips open after consecutive failures, then fails fast', async () => {
    const { client, warns } = install(async () => {
      throw new Error('ECONNRESET');
    });
    try {
      for (let i = 0; i < 5; i++) {
        await assert.rejects(fetch('https://rpc-backend.example/'));
      }

      // While open, requests fail fast without another backend attempt:
      // the failure count stops climbing.
      await assert.rejects(fetch('https://rpc-backend.example/'), /Breaker is open/);
      const { state, failures } = client.stats()['https://rpc-backend.example'];
      assert.equal(state, 'open');
      assert.ok(failures >= 3, `expected several recorded failures, got ${failures}`);
      assert.ok(warns.some(w => w.includes('OPEN')));
    } finally {
      client.restore();
    }
  });

  test('half-open probes recover to closed when the backend heals', async () => {
    let healthy = false;
    const { client, logs } = install(async () => {
      if (!healthy) throw new Error('ETIMEDOUT');
      return new Response('{}', { status: 200 });
    });
    try {
      for (let i = 0; i < 4; i++) {
        await assert.rejects(fetch('https://horizon.example/'));
      }
      assert.equal(client.stats()['https://horizon.example'].state, 'open');

      healthy = true;
      // Wait out the reset timeout: the breaker goes half-open and lets a
      // single probe through.
      await sleep(150);
      const res = await fetch('https://horizon.example/');
      assert.equal(res.status, 200);

      // Recovery closes the circuit.
      await sleep(10);
      assert.equal(client.stats()['https://horizon.example'].state, 'closed');
      assert.ok(logs.some(l => l.includes('CLOSED')));
      assert.ok(logs.some(l => l.includes('HALF-OPEN')));
    } finally {
      client.restore();
    }
  });

  test('breakers are per origin — testnet trouble does not block pubnet', async () => {
    const { client } = install(async () => {
      throw new Error('EAI_AGAIN');
    });
    try {
      for (let i = 0; i < 4; i++) {
        await assert.rejects(fetch('https://testnet-rpc.example/'));
      }
      assert.equal(client.stats()['https://testnet-rpc.example'].state, 'open');

      // A different origin has its own breaker, untouched by the failures.
      await assert.rejects(fetch('https://pubnet-rpc.example/'), /EAI_AGAIN/);
      assert.equal(client.stats()['https://pubnet-rpc.example'].state, 'closed');
    } finally {
      client.restore();
    }
  });

  test('restore() puts the original fetch back', async () => {
    const original = globalThis.fetch;
    const { client } = install(async () => new Response('{}', { status: 200 }));
    assert.notEqual(globalThis.fetch, original);
    client.restore();
    assert.equal(globalThis.fetch, original);
  });
});

describe('dynamic fee estimation (#426)', () => {
  const feeStats = ({ p50, p90, p99, base = '100', usage = '0.2' }) => ({
    last_ledger_base_fee: base,
    ledger_capacity_usage: usage,
    fee_charged: { p50, p90, p99 },
  });
  const okFetch =
    (body, calls = []) =>
    async url => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status: 200 });
    };
  const NORMAL = feeStats({ p50: '100', p90: '120', p99: '300' });
  const CONGESTED = feeStats({ p50: '5000', p90: '40000', p99: '900000', usage: '1.0' });

  test('fetchFeeStats returns p50/p90/p99 from /fee_stats', async () => {
    const calls = [];
    const est = createFeeEstimator({
      horizonUrl: 'https://horizon.example/',
      maxFeeStroops: 50_000,
      fetchFn: okFetch(NORMAL, calls),
    });
    const stats = await est.fetchFeeStats();
    assert.deepEqual([stats.p50, stats.p90, stats.p99], [100, 120, 300]);
    assert.equal(calls[0], 'https://horizon.example/fee_stats');
  });

  test('stats are cached for 5s and concurrent callers share one request', async () => {
    let t = 1000;
    const calls = [];
    const est = createFeeEstimator({
      horizonUrl: 'https://h',
      maxFeeStroops: 50_000,
      fetchFn: okFetch(NORMAL, calls),
      now: () => t,
    });
    await Promise.all([est.fetchFeeStats(), est.fetchFeeStats(), est.fetchFeeStats()]);
    assert.equal(calls.length, 1);
    t += FEE_STATS_TTL_MS - 1;
    await est.fetchFeeStats();
    assert.equal(calls.length, 1, 'still fresh just under the TTL');
    t += 1;
    await est.fetchFeeStats();
    assert.equal(calls.length, 2, 'refetched once the TTL elapses');
  });

  test('normal network: priority picks the percentile', async () => {
    const est = createFeeEstimator({
      horizonUrl: 'https://h',
      maxFeeStroops: 50_000,
      fetchFn: okFetch(NORMAL),
    });
    assert.equal((await est.estimateFee({ priority: 'low' })).feeStroops, 100);
    assert.equal((await est.estimateFee({ priority: 'normal' })).feeStroops, 120);
    assert.equal((await est.estimateFee({ priority: 'high' })).feeStroops, 300);
  });

  test('a tight deadline bumps the bid one tier; a relaxed one does not', async () => {
    const est = createFeeEstimator({
      horizonUrl: 'https://h',
      maxFeeStroops: 50_000,
      fetchFn: okFetch(NORMAL),
    });
    const urgent = await est.estimateFee({ priority: 'normal', deadlineMs: 2000 });
    assert.equal(urgent.tier, 'high');
    assert.equal(urgent.feeStroops, 300);
    const relaxed = await est.estimateFee({ priority: 'normal', deadlineMs: 60_000 });
    assert.equal(relaxed.tier, 'normal');
    const top = await est.estimateFee({ priority: 'high', deadlineMs: 1 });
    assert.equal(top.tier, 'high', 'cannot bump past the top tier');
  });

  test('high congestion: bids rise but never exceed the ceiling', async () => {
    const est = createFeeEstimator({
      horizonUrl: 'https://h',
      maxFeeStroops: 50_000,
      fetchFn: okFetch(CONGESTED),
    });
    const normal = await est.estimateFee({ priority: 'normal' });
    assert.equal(normal.feeStroops, 40_000);
    assert.equal(normal.capped, false);
    const high = await est.estimateFee({ priority: 'high' });
    assert.equal(high.feeStroops, 50_000, 'p99 of 900000 is clamped to the ceiling');
    assert.equal(high.capped, true);
  });

  test('bids never fall below the ledger base fee', async () => {
    const est = createFeeEstimator({
      horizonUrl: 'https://h',
      maxFeeStroops: 50_000,
      fetchFn: okFetch(feeStats({ p50: '50', p90: '50', p99: '50', base: '200' })),
    });
    assert.equal((await est.estimateFee({ priority: 'low' })).feeStroops, 200);
  });

  test('Horizon failure: uses stale stats, else the minimum fee, still under the ceiling', async () => {
    let t = 0;
    let fail = false;
    const est = createFeeEstimator({
      horizonUrl: 'https://h',
      maxFeeStroops: 50_000,
      now: () => t,
      fetchFn: async () => {
        if (fail) throw new Error('ECONNRESET');
        return new Response(JSON.stringify(CONGESTED), { status: 200 });
      },
    });
    fail = true;
    const cold = await est.estimateFee({ priority: 'high' });
    assert.deepEqual([cold.feeStroops, cold.source], [MIN_BASE_FEE_STROOPS, 'fallback']);

    fail = false;
    await est.fetchFeeStats();
    fail = true;
    t += 60_000;
    const stale = await est.estimateFee({ priority: 'normal' });
    assert.deepEqual([stale.feeStroops, stale.source], [40_000, 'stale']);
  });

  test('rejects malformed responses, bad priorities, bad deadlines and bad ceilings', async () => {
    const bad = createFeeEstimator({
      horizonUrl: 'https://h',
      maxFeeStroops: 50_000,
      fetchFn: okFetch({ fee_charged: { p50: '100' } }),
    });
    await assert.rejects(bad.fetchFeeStats(), /missing fee_charged\.p90/);

    const est = createFeeEstimator({
      horizonUrl: 'https://h',
      maxFeeStroops: 50_000,
      fetchFn: okFetch(NORMAL),
    });
    await assert.rejects(est.estimateFee({ priority: 'urgent' }), /Unknown fee priority/);
    await assert.rejects(est.estimateFee({ deadlineMs: -5 }), /deadlineMs/);
    assert.throws(
      () => createFeeEstimator({ horizonUrl: 'https://h', maxFeeStroops: 10 }),
      />= 100/,
    );
    assert.throws(() => createFeeEstimator({ maxFeeStroops: 5000 }), /horizonUrl/);
  });
});
