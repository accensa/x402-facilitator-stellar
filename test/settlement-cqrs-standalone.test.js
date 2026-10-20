/**
 * Standalone test for CQRS event streaming pipeline
 * Tests the core logic without external dependencies
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CheckpointManager,
  EventStreamReader,
  ProjectionWriter,
  ProjectionWorker,
} from '../src/settlement-cqrs.js';
import { SETTLEMENT_EVENT_TYPES } from '../src/eventstore/events.js';
import { createMetrics } from '../src/metrics.js';
import { validateEventOrdering } from '../src/eventstore/projection-worker.js';

/**
 * Minimal fake pool for testing
 */
function createFakePool() {
  const events = [];
  const projections = new Map();
  let checkpointSeq = 0;

  return {
    events,
    projections,
    on: () => {},
    query: async (text, params = []) => {
      const flat = text.replace(/\s+/g, ' ').trim();

      if (/CREATE TABLE|CREATE INDEX/.test(flat)) {
        return { rows: [] };
      }

      if (flat.includes('settlement_projection_checkpoint')) {
        if (flat.includes('INSERT INTO')) return { rows: [] };
        if (flat.includes('SELECT last_seq')) {
          return { rows: [{ last_seq: checkpointSeq }] };
        }
        if (flat.includes('UPDATE')) {
          checkpointSeq = params[0];
          return { rows: [] };
        }
      }

      if (flat.includes('FROM settlement_events e WHERE e.seq >')) {
        const fromSeq = params[0];
        const limit = params[1];
        const batch = events.filter(e => e.seq > fromSeq).slice(0, limit);
        return { rows: batch };
      }

      if (flat.includes('MAX(seq)')) {
        const maxSeq = events.length > 0 ? Math.max(...events.map(e => e.seq)) : 0;
        return { rows: [{ max_seq: maxSeq }] };
      }

      if (flat.includes('WHERE idempotency_key = $1') && flat.includes('ORDER BY seq')) {
        const key = params[0];
        const keyEvents = events.filter(e => e.idempotency_key === key);
        return { rows: keyEvents };
      }

      if (flat.includes('INSERT INTO settlement_read_model')) {
        const key = params[0];
        projections.set(key, {
          idempotency_key: key,
          key_id: params[1],
          state: params[8],
          tx_hash: params[9],
          last_event_seq: params[14],
        });
        return { rows: [] };
      }

      return { rows: [] };
    },
  };
}

function createMockMetrics() {
  return {
    setProjectionLag: () => {},
    incProjectionEventsProcessed: () => {},
    observeProjectionBatchDuration: () => {},
    setProjectionThroughput: () => {},
  };
}

describe('CQRS Event Streaming - Core Functionality', () => {
  test('CheckpointManager persists checkpoint offset', async () => {
    const pool = createFakePool();
    const checkpoint = new CheckpointManager(pool, { info: () => {} });

    await checkpoint.initialize();
    assert.strictEqual(checkpoint.getOffset(), 0);

    await checkpoint.updateCheckpoint(100);
    assert.strictEqual(checkpoint.getOffset(), 100);
  });

  test('EventStreamReader reads events in batches', async () => {
    const pool = createFakePool();
    pool.events.push(
      {
        seq: 1,
        idempotency_key: 'test-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        payload: { idempotency_key: 'test-1', network: 'stellar:testnet', scheme: 'exact-stellar' },
        recorded_at: new Date().toISOString(),
      },
      {
        seq: 2,
        idempotency_key: 'test-1',
        event_type: SETTLEMENT_EVENT_TYPES.SETTLED,
        payload: { idempotency_key: 'test-1', tx_hash: 'abc123' },
        recorded_at: new Date().toISOString(),
      },
    );

    const reader = new EventStreamReader(pool, { info: () => {} });
    const batch = await reader.readBatch(0, 10);

    assert.strictEqual(batch.length, 2);
    assert.strictEqual(batch[0].seq, 1);
    assert.strictEqual(batch[1].seq, 2);
  });

  test('ProjectionWriter writes projections to read model', async () => {
    const pool = createFakePool();
    const writer = new ProjectionWriter(pool, { info: () => {} });

    await writer.initialize();

    const projection = {
      idempotency_key: 'proj-1',
      key_id: 'merchant-1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      payer: null,
      pay_to: null,
      asset: null,
      amount: null,
      state: 'settled',
      tx_hash: 'hash123',
      error_reason: null,
      error_message: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await writer.writeProjection(projection, 1);

    assert.ok(pool.projections.has('proj-1'));
    assert.strictEqual(pool.projections.get('proj-1').state, 'settled');
    assert.strictEqual(pool.projections.get('proj-1').tx_hash, 'hash123');
  });

  test('ProjectionWorker processes batch and updates checkpoint', async () => {
    const pool = createFakePool();
    pool.events.push({
      seq: 1,
      idempotency_key: 'worker-1',
      event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
      event_version: 1,
      payload: {
        idempotency_key: 'worker-1',
        network: 'stellar:testnet',
        scheme: 'exact-stellar',
        key_id: 'merchant-1',
      },
      recorded_at: new Date().toISOString(),
    });

    const metrics = createMockMetrics();
    const worker = new ProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.initialize();
    assert.strictEqual(worker.checkpoint.getOffset(), 0);

    await worker.processBatch();

    assert.strictEqual(worker.checkpoint.getOffset(), 1);
    assert.ok(pool.projections.has('worker-1'));
  });

  test('Out-of-order event validation sorts events correctly', () => {
    const events = [
      { seq: 3, idempotency_key: 'a' },
      { seq: 1, idempotency_key: 'a' },
      { seq: 2, idempotency_key: 'a' },
    ];

    const ordered = validateEventOrdering(events);
    const settlementEvents = ordered.get('a');

    assert.strictEqual(settlementEvents[0].seq, 1);
    assert.strictEqual(settlementEvents[1].seq, 2);
    assert.strictEqual(settlementEvents[2].seq, 3);
  });

  test('Projection handles multiple settlements in one batch', async () => {
    const pool = createFakePool();
    pool.events.push(
      {
        seq: 1,
        idempotency_key: 'multi-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'multi-1',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
      {
        seq: 2,
        idempotency_key: 'multi-2',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'multi-2',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
    );

    const metrics = createMockMetrics();
    const worker = new ProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.initialize();
    await worker.processBatch();

    assert.strictEqual(pool.projections.size, 2);
    assert.ok(pool.projections.has('multi-1'));
    assert.ok(pool.projections.has('multi-2'));
  });

  test('The worker publishes the projection throughput gauge (#557)', async () => {
    const pool = createFakePool();
    pool.events.push(
      {
        seq: 1,
        idempotency_key: 'thr-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'thr-1',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
      {
        seq: 2,
        idempotency_key: 'thr-2',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'thr-2',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
    );

    const metrics = createMetrics();
    const seen = {
      throughput: 0,
      processed: 0,
      duration: null,
    };
    assert.equal(typeof metrics.setProjectionThroughput, 'function');
    const realSetThroughput = metrics.setProjectionThroughput.bind(metrics);
    metrics.setProjectionThroughput = value => {
      seen.throughput = value;
      realSetThroughput(value);
    };
    const realIncProcessed = metrics.incProjectionEventsProcessed.bind(metrics);
    metrics.incProjectionEventsProcessed = count => {
      seen.processed = count;
      realIncProcessed(count);
    };
    const realObserveDuration = metrics.observeProjectionBatchDuration.bind(metrics);
    metrics.observeProjectionBatchDuration = value => {
      seen.duration = value;
      realObserveDuration(value);
    };

    const worker = new ProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.initialize();
    await worker.processBatch();

    // The gauge was actually driven by the worker and reads back through the
    // exposition format, not only through the mutator.
    const exposition = metrics.render();
    const gaugeLines = exposition
      .split('\n')
      .filter(l => l.startsWith('x402_projection_throughput_events_per_second '));
    const value = Number(gaugeLines.at(-1).split(' ')[1]);

    assert.equal(gaugeLines.length, 1, 'the throughput series appears exactly once');
    assert.ok(Number.isFinite(value), 'the exposition value is a finite number');
    assert.ok(value > 0, `the throughput gauge is non-zero (${gaugeLines.at(-1)})`);

    // Consistency: the same batch's processed count and duration are the
    // inputs to the rate, scraped beside it.
    assert.ok(seen.processed > 0);
    assert.ok(seen.duration >= 0);
    const extremeRate = seen.processed / seen.duration;
    assert.ok(
      !Number.isFinite(extremeRate) || Math.abs(value - extremeRate) < 1e-6 * Math.max(value, 1),
      `gauge (${value}) is consistent with processed(${seen.processed})/duration(${seen.duration})`,
    );

    // Empty batch: processBatch returns before the metric block; the gauge
    // keeps its last reading and gains no second series.
    const before = metrics.render();
    await worker.processBatch();
    const after = metrics.render();
    assert.strictEqual(before, after, 'an empty batch leaves the exposition unchanged');

    // The doubled set (rawRate Infinity path) is impossible: the setProjection
    // mutator always receives a finite number.
    assert.ok(Number.isFinite(seen.throughput));
  });
});
