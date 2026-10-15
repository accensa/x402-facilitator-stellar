/**
 * The DLQ worker's operator contract (#559).
 *
 * `startDlqWorker` (src/dlq/worker.js:106-161) owns two behaviours nothing
 * tested before:
 *   - its `tick` fires at most one `onAlert` per breach: `alerting` latches
 *     when `pending + exhausted` crosses `alertThreshold` and only resets when
 *     depth falls back to or below it — a stuck queue may not spam the sink
 *     every poll (the promise in the header comment at :96-99);
 *   - it is the only writer of the `x402_dlq_depth` gauge: `onDepth` receives
 *     `{status: 'pending'}` and `{status: 'exhausted'}` carrying the store's
 *     counts (src/server.js:265 wires it to `metrics.setDlqDepth`).
 *
 * Both failure paths of `pollDlqOnce` are driven here too: a rejecting
 * `claimDue` (depth null, the worker stays usable, the failure is logged) and
 * a rejecting `countByStatus` (depth null → neither `onDepth` nor `onAlert`
 * fires). Every case drives `tick()` directly — no `start()`, no interval, no
 * network.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startDlqWorker } from '../src/dlq/worker.js';

function createDlqStub({ claimDue = async () => [], countByStatus = async () => ({}) } = {}) {
  return { claimDue, countByStatus };
}

function makeWorker(dlq, { log = () => {}, alertThreshold, onAlert, onDepth } = {}) {
  return startDlqWorker({
    dlq,
    publish: async () => {},
    log,
    alertThreshold,
    onAlert,
    onDepth,
  });
}

describe('DLQ worker alert contract', () => {
  test('a queue that stays over threshold alerts exactly once across consecutive ticks', async () => {
    const alerts = [];
    const dlq = createDlqStub({
      countByStatus: async () => ({ pending: 5, exhausted: 0 }),
    });
    const worker = makeWorker(dlq, {
      alertThreshold: 3,
      onAlert: depth => alerts.push(depth),
    });

    for (let i = 0; i < 3; i += 1) await worker.tick();

    assert.strictEqual(alerts.length, 1, 'one alert per breach, not one per poll');
    assert.strictEqual(alerts[0].pending, 5);
  });

  test('the alert re-arms once depth falls back to the threshold', async () => {
    const alerts = [];
    // Above threshold (5 > 3), then back at the threshold (3 <= 3), then over again.
    const depths = [
      { pending: 5, exhausted: 0 },
      { pending: 3, exhausted: 0 },
      { pending: 4, exhausted: 0 },
    ];
    let call = 0;
    const dlq = createDlqStub({
      countByStatus: async () => depths[Math.min(call, depths.length - 1)],
    });
    const realPoll = dlq.countByStatus;
    dlq.countByStatus = async (...args) =>
      realPoll(...args).then(d => {
        call += 1;
        return d;
      });

    const worker = makeWorker(dlq, {
      alertThreshold: 3,
      onAlert: depth => alerts.push(depth),
    });

    await worker.tick(); // 5 > 3 → alert, latch
    await worker.tick(); // 3 <= 3 → reset the latch, no alert
    await worker.tick(); // 4 > 3 → alert again

    assert.strictEqual(alerts.length, 2, 're-armed: breach, recover, breach');
  });

  test('alertThreshold = 0 never alerts, even over a big queue', async () => {
    const alerts = [];
    const dlq = createDlqStub({
      countByStatus: async () => ({ pending: 999, exhausted: 999 }),
    });
    const worker = makeWorker(dlq, {
      alertThreshold: 0,
      onAlert: depth => alerts.push(depth),
    });

    await worker.tick();
    await worker.tick();

    assert.strictEqual(alerts.length, 0);
  });
});

describe('DLQ worker depth gauge contract', () => {
  test('onDepth receives pending and exhausted with the store counts', async () => {
    const seen = [];
    const dlq = createDlqStub({
      countByStatus: async () => ({ pending: 7, exhausted: 2 }),
    });
    const worker = makeWorker(dlq, {
      onDepth: gauge => seen.push(gauge),
    });

    await worker.tick();

    assert.deepEqual(seen, [
      { status: 'pending', value: 7 },
      { status: 'exhausted', value: 2 },
    ]);
  });

  test('no onDepth emissions without an onDepth sink — worker still ticks', async () => {
    const dlq = createDlqStub();
    const worker = makeWorker(dlq);
    await worker.tick(); // must not throw
  });
});

describe('DLQ worker failure paths', () => {
  test('a rejecting claimDue logs through `log` and leaves the worker usable', async () => {
    const logs = [];
    const alerts = [];
    const depths = [{ pending: 9, exhausted: 0 }];
    let call = 0;
    const dlq = {
      claimDue: async () => {
        throw new Error('claim window exploded');
      },
      countByStatus: async () => {
        call += 1;
        return depths[0];
      },
    };
    const worker = makeWorker(dlq, {
      log: msg => logs.push(msg),
      alertThreshold: 1,
      onAlert: depth => alerts.push(depth),
    });

    await worker.tick(); // claimDue throws → depth null → no alert
    assert.strictEqual(alerts.length, 0);
    assert.ok(
      logs.some(l => l.includes('poll failed') && l.includes('claim window exploded')),
      'the failure is reported through `log`',
    );

    // The worker is still usable: a store recovery produces a normal tick.
    dlq.claimDue = async () => [];
    await worker.tick();
    assert.strictEqual(call, 1); // countByStatus was only reached on the second tick
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].pending, 9);
  });

  test('a rejecting countByStatus yields depth: null so neither onDepth nor onAlert fires', async () => {
    const alerts = [];
    const depthCalls = [];
    const dlq = createDlqStub({
      countByStatus: async () => {
        throw new Error('stats query failed');
      },
    });
    const worker = makeWorker(dlq, {
      alertThreshold: 1,
      onAlert: depth => alerts.push(depth),
      onDepth: gauge => depthCalls.push(gauge),
    });

    await worker.tick();

    assert.strictEqual(depthCalls.length, 0, 'no gauge writes without a depth reading');
    assert.strictEqual(alerts.length, 0, 'no alert without a depth reading');
  });
});
