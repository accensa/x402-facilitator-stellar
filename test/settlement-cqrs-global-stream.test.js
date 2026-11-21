import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointManager, EventStreamReader, ProjectionWorker } from '../src/settlement-cqrs.js';
import { SETTLEMENT_EVENT_TYPES } from '../src/eventstore/events.js';

const log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const metrics = {
  setProjectionLag: () => {},
  incProjectionEventsProcessed: () => {},
  observeProjectionBatchDuration: () => {},
  setProjectionThroughput: () => {},
};

function createGlobalStreamPool(events) {
  const projections = new Map();
  let checkpointId = 0;

  return {
    projections,
    on: () => {},
    get checkpointId() {
      return checkpointId;
    },
    query: async (text, params = []) => {
      const flat = text.replace(/\s+/g, ' ').trim();

      if (/CREATE TABLE|CREATE INDEX/.test(flat)) return { rows: [] };

      if (flat.includes('settlement_projection_checkpoint')) {
        if (flat.includes('INSERT INTO')) return { rows: [] };
        if (flat.includes('SELECT last_seq')) return { rows: [{ last_seq: checkpointId }] };
        if (flat.includes('UPDATE')) {
          checkpointId = params[0];
          return { rows: [] };
        }
      }

      if (flat.includes('e.id > $1')) {
        const fromId = params[0];
        const limit = params[1];
        return {
          rows: events
            .filter(event => event.id > fromId)
            .sort((a, b) => a.id - b.id)
            .slice(0, limit),
        };
      }

      if (flat.includes('MAX(id)')) {
        const maxId = events.reduce((max, event) => Math.max(max, Number(event.id)), 0);
        const maxSeq = events.reduce((max, event) => Math.max(max, Number(event.seq)), 0);
        return { rows: [{ max_seq: maxId, legacy_max_seq: maxSeq }] };
      }

      if (flat.includes('WHERE idempotency_key = $1') && flat.includes('ORDER BY seq')) {
        const key = params[0];
        return {
          rows: events.filter(event => event.idempotency_key === key).sort((a, b) => a.seq - b.seq),
        };
      }

      if (flat.includes('INSERT INTO settlement_read_model')) {
        projections.set(params[0], {
          idempotency_key: params[0],
          state: params[8],
          tx_hash: params[9],
          last_event_seq: params[14],
        });
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${flat}`);
    },
  };
}

const recordedAt = '2026-11-21T00:00:00.000Z';

function initiated(id, seq, key) {
  return {
    id,
    seq,
    idempotency_key: key,
    event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
    event_version: 1,
    payload: {
      idempotency_key: key,
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      key_id: 'merchant-1',
    },
    recorded_at: recordedAt,
  };
}

function settled(id, seq, key, txHash) {
  return {
    id,
    seq,
    idempotency_key: key,
    event_type: SETTLEMENT_EVENT_TYPES.SETTLED,
    event_version: 1,
    payload: { idempotency_key: key, tx_hash: txHash },
    recorded_at: recordedAt,
  };
}

describe('settlement event stream uses global event ids', () => {
  test('EventStreamReader orders multiple settlements by global id, not per-settlement seq', async () => {
    const events = [
      initiated(1, 1, 'settlement-A'),
      initiated(2, 1, 'settlement-B'),
      initiated(3, 2, 'settlement-A'),
      initiated(4, 1, 'settlement-C'),
    ];
    const reader = new EventStreamReader(createGlobalStreamPool(events), log);

    const firstBatch = await reader.readBatch(0, 2);
    assert.deepEqual(
      firstBatch.map(event => event.id),
      [1, 2],
    );
    assert.deepEqual(
      firstBatch.map(event => event.idempotency_key),
      ['settlement-A', 'settlement-B'],
    );

    const secondBatch = await reader.readBatch(2, 2);
    assert.deepEqual(
      secondBatch.map(event => event.id),
      [3, 4],
    );
    assert.deepEqual(
      secondBatch.map(event => event.idempotency_key),
      ['settlement-A', 'settlement-C'],
    );

    assert.equal(Math.max(...events.map(event => event.seq)), 2);
    assert.equal(await reader.getMaxSequence(), 4);
  });

  test('ProjectionWorker checkpoints global id when settlements share seq=1', async () => {
    const events = [
      initiated(1, 1, 'settlement-A'),
      initiated(2, 1, 'settlement-B'),
      settled(3, 2, 'settlement-A', 'hash-A'),
      initiated(4, 1, 'settlement-C'),
    ];
    const pool = createGlobalStreamPool(events);
    const worker = new ProjectionWorker(pool, metrics, { log, batchSize: 2 });

    await worker.initialize();
    await worker.processBatch();
    assert.equal(worker.checkpoint.getOffset(), 2);
    assert.equal(pool.checkpointId, 2);

    await worker.processBatch();
    assert.equal(worker.checkpoint.getOffset(), 4);
    assert.equal(pool.checkpointId, 4);
    assert.deepEqual([...pool.projections.keys()].sort(), [
      'settlement-A',
      'settlement-B',
      'settlement-C',
    ]);
    assert.equal(pool.projections.get('settlement-A').state, 'settled');
    assert.equal(pool.projections.get('settlement-A').tx_hash, 'hash-A');
    assert.equal(pool.projections.get('settlement-A').last_event_seq, 3);

    await worker.processBatch();
    assert.equal(worker.checkpoint.getOffset(), 4);
  });

  test('CheckpointManager persists the global id in the existing last_seq column', async () => {
    const pool = createGlobalStreamPool([]);
    const checkpoint = new CheckpointManager(pool, log);

    await checkpoint.initialize();
    assert.equal(checkpoint.getOffset(), 0);

    await checkpoint.updateCheckpoint(9);
    assert.equal(checkpoint.getOffset(), 9);
    assert.equal(pool.checkpointId, 9);
  });
});
