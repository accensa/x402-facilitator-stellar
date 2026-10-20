/**
 * DLQ worker alert and depth gauge (#559).
 *
 * `startDlqWorker` in src/dlq/worker.js owns two operator-facing behaviours
 * with no other cover: the edge-triggered depth alert (at most one `onAlert`
 * per breach, re-armed when depth drops back to the threshold, comment
 * #DLQ) and the two `x402_dlq_depth` series pushed through `onDepth`.
 *
 * The store is an in-memory stub shaped like
 * `import('./dlq/store.js').DeadLetterStore`; only `claimDue`,
 * `markResolved`, `markRetryFailed` and `countByStatus` are exercised.
 * The interval loop is never started — the tests drive `tick()` directly
 * so the suite stays offline, fast, and deterministic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startDlqWorker, pollDlqOnce } from '../src/dlq/worker.js';

const log = () => {};

/**
 * Builds a store stub. `due` is the queue claimDue returns; the counters are
 * read from `depth`. Each collaborator can be replaced by a function that
 * throws to drive the failure paths.
 */
function makeStore({
  due = [],
  depth = { pending: 0, exhausted: 0, resolved: 0, discarded: 0 },
  claimDue: onClaimDue,
  countByStatus: onCountByStatus,
} = {}) {
  return {
    claimDue: onClaimDue ?? (() => Promise.resolve([...due])),
    countByStatus: onCountByStatus ?? (() => Promise.resolve({ ...depth })),
    markResolved: () => Promise.resolve(),
    markRetryFailed: () => Promise.resolve(),
  };
}

const publish = () => Promise.resolve();

describe('startDlqWorker alert', () => {
  test('alerts exactly once across three consecutive over-threshold ticks', async () => {
    const store = makeStore({ depth: { pending: 5, exhausted: 0 } });
    const alerts = [];
    const worker = startDlqWorker({
      dlq: store,
      publish,
      alertThreshold: 3,
      onAlert: depth => alerts.push({ ...depth }),
      log,
    });

    await worker.tick();
    await worker.tick();
    await worker.tick();

    assert.equal(
      alerts.length,
      1,
      'a queue that stays over the threshold alerts once, not per poll',
    );
    assert.equal(alerts[0].pending, 5);
  });

  test('re-arms after the depth falls back to the threshold and alerts again on the next breach', async () => {
    const current = { pending: 5, exhausted: 1 };
    const store = makeStore({
      depth: current,
      countByStatus: () => Promise.resolve({ ...current }),
    });
    const alerts = [];
    const worker = startDlqWorker({
      dlq: store,
      publish,
      alertThreshold: 5,
      onAlert: depth => alerts.push(depth.pending + depth.exhausted),
      log,
    });

    await worker.tick();
    assert.equal(alerts.length, 1);

    // Back at the threshold: no longer a breach, and the latch resets.
    current.pending = 3;
    current.exhausted = 2;
    await worker.tick();
    assert.equal(alerts.length, 1, 'at-threshold is not a breach');

    // Breach again: the second alert fires because the latch was reset.
    current.pending = 4;
    current.exhausted = 2;
    await worker.tick();
    assert.equal(alerts.length, 2, 'falling back to the threshold re-arms the alert');
  });

  test('alertThreshold = 0 never alerts', async () => {
    const store = makeStore({ depth: { pending: 100, exhausted: 50 } });
    const alerts = [];
    const worker = startDlqWorker({
      dlq: store,
      publish,
      alertThreshold: 0,
      onAlert: depth => alerts.push(depth),
      log,
    });

    await worker.tick();
    await worker.tick();

    assert.equal(alerts.length, 0);
  });
});

describe('startDlqWorker depth gauge', () => {
  test('onDepth receives the pending and exhausted series with the store counts', async () => {
    const store = makeStore({ depth: { pending: 7, exhausted: 3 } });
    const gauges = [];
    const worker = startDlqWorker({
      dlq: store,
      publish,
      alertThreshold: 1000,
      onDepth: gauge => gauges.push(gauge),
      log,
    });

    await worker.tick();

    assert.deepStrictEqual(gauges, [
      { status: 'pending', value: 7 },
      { status: 'exhausted', value: 3 },
    ]);
  });

  test('a rejecting countByStatus yields depth null and fires neither onDepth nor onAlert', async () => {
    let countCalls = 0;
    const store = makeStore({
      due: [],
      countByStatus: () => {
        countCalls++;
        return Promise.reject(new Error('count query down'));
      },
    });
    const sinks = [];
    let alerted = false;
    const logs = [];
    const worker = startDlqWorker({
      dlq: store,
      publish,
      alertThreshold: 2,
      onDepth: g => sinks.push(g),
      onAlert: () => {
        alerted = true;
      },
      log: msg => logs.push(msg),
    });

    await worker.tick();

    assert.equal(countCalls, 1);
    assert.equal(sinks.length, 0, 'no gauge emission when the depth query fails');
    assert.equal(alerted, false, 'no alert without a depth reading');
    assert.equal(logs.length, 0, 'depth-null is a quiet return, not an error path');

    // Same contract at the pollDlqOnce level.
    const result = await pollDlqOnce({ dlq: store, publish, log });
    assert.equal(result.depth, null);
  });

  test('a rejecting claimDue logs and leaves the worker usable on the next tick', async () => {
    let calls = 0;
    const store = makeStore({
      claimDue: () => {
        calls++;
        return Promise.reject(new Error('claim query down'));
      },
      depth: { pending: 1, exhausted: 0 },
    });
    const logs = [];
    const gauges = [];
    const worker = startDlqWorker({
      dlq: store,
      publish,
      alertThreshold: 5,
      onDepth: g => gauges.push(g),
      log: msg => logs.push(msg),
    });

    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(gauges.length, 0, 'no depth is pushed when the poll never completed');
    assert.equal(logs.length, 1, 'the failing poll is reported through log');
    assert.match(logs[0], /poll failed/);

    // Recover: the same worker keeps working after a failed poll.
    store.claimDue = () => Promise.resolve([]);
    await worker.tick();
    assert.deepStrictEqual(gauges, [
      { status: 'pending', value: 1 },
      { status: 'exhausted', value: 0 },
    ]);
  });
});
