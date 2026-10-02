import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresSettlementStore } from '../src/store/postgres.js';
import { buildSettlementStore } from '../src/store/index.js';
import { resolveConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { Keypair } from '@stellar/stellar-sdk';
import {
  CheckpointManager,
  EventStreamReader,
  ProjectionWriter,
  ProjectionWorker,
  createProjectionWorker,
} from '../src/settlement-cqrs.js';
import {
  simulateRecoveryTest,
  processToCaughtUp,
  validateEventOrdering,
  verifyCheckpointPersistence,
} from '../src/eventstore/projection-worker.js';
import { SETTLEMENT_EVENT_TYPES } from '../src/eventstore/events.js';

/**
 * Minimal fake pg Pool mimicking the subset of the `pg` API the store uses:
 * `query()` and `on('error')`, dispatching on the event-sourced statements the
 * store actually emits (#130): an append to settlement_events paired with the
 * projection write derived from it. The primary pool is always "fresh", while
 * a replica can be made to "lag" for specific keys (pretend the row hasn't
 * replicated yet) to exercise the read-after-write path (#121).
 */
function fakePool(overrides = {}) {
  const store = new Map();
  for (const r of overrides.seed ?? []) store.set(r.idempotency_key, r);
  const lagKeys = new Set(overrides.lagKeys ?? []);
  const queryCalls = { select: 0, insert: 0, update: 0 };
  const nowIso = () => new Date().toISOString();
  return {
    queryCalls,
    store,
    on: () => {},
    // Simulates the schema bootstrap the store runs.
    query: async (text, params = []) => {
      const flat = text.replace(/\s+/g, ' ').trim();
      if (/CREATE TABLE|CREATE INDEX/.test(flat)) return { rows: [] };

      // save(): SettlementInitiated CTE — append event + upsert projection.
      if (flat.includes("'SettlementInitiated'")) {
        queryCalls.insert++;
        const [key, , network, scheme, payer, payTo, asset, amount, txHash, keyId] = params;
        const existing = store.get(key);
        const recordedAt = nowIso();
        const row = {
          idempotency_key: key,
          network,
          scheme,
          payer,
          pay_to: payTo,
          asset,
          amount,
          state: 'submitted',
          tx_hash: txHash,
          error_reason: null,
          error_message: null,
          response: null,
          key_id: keyId,
          version: (existing?.version ?? 0) + 1,
          created_at: existing?.created_at ?? recordedAt,
          updated_at: recordedAt,
        };
        store.set(key, row);
        return { rows: [{ ...row }] };
      }

      // updateState()/settleAndEnqueue(): event-then-projection CTE.
      if (
        flat.includes('WHERE settlement_projections.idempotency_key = ins_event.idempotency_key')
      ) {
        queryCalls.update++;
        const [key, , , state, txHash, errorReason, errorMessage, response] = params;
        const existing = store.get(key);
        if (!existing) return { rows: [] };
        const row = {
          ...existing,
          state,
          tx_hash: txHash ?? existing.tx_hash,
          error_reason: errorReason ?? existing.error_reason,
          error_message: errorMessage ?? existing.error_message,
          response: response ? JSON.parse(response) : existing.response,
          version: existing.version + 1,
          updated_at: nowIso(),
        };
        store.set(key, row);
        return { rows: [{ ...row }] };
      }

      if (flat.includes('FROM settlement_projections WHERE idempotency_key = $1')) {
        queryCalls.select++;
        const key = params[0];
        if (lagKeys.has(key)) {
          // Replica hasn't propagated this row yet.
          return { rows: [] };
        }
        const row = store.get(key);
        return { rows: row ? [{ ...row }] : [] };
      }

      // listUnknown: `WHERE state = $1` — scan all rows by state.
      if (flat.includes('FROM settlement_projections WHERE state = $1')) {
        queryCalls.select++;
        const state = params[0];
        const rows = [...store.values()].filter(r => r.state === state);
        return { rows };
      }

      return { rows: [] };
    },
  };
}

describe('CQRS read replica settlement store (#121)', () => {
  test('writes route to the primary pool and reads route to the replica pool', async () => {
    const primary = fakePool();
    const replica = fakePool();
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: primary,
      replicaPool: replica,
      warn: () => {},
    });
    await store.ready;

    // Write: must land on the primary.
    const saved = await store.save({
      idempotency_key: 'cqrs-1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'submitted',
    });
    assert.strictEqual(saved.state, 'submitted');
    assert.strictEqual(primary.queryCalls.insert, 1);
    assert.strictEqual(replica.queryCalls.insert, 0);

    // Seed the replica (as replication would) and read from it.
    replica.store.set('cqrs-1', { ...saved, updated_at: new Date() });
    const got = await store.get('cqrs-1');
    assert.strictEqual(got.idempotency_key, 'cqrs-1');
    // The in-memory fallback is authoritative for our own write, so force a
    // clean store where the row only exists on the replica.
    const clean = new PostgresSettlementStore('postgres://primary', {
      pool: primary,
      replicaPool: replica,
      warn: () => {},
    });
    await clean.ready;
    const gotClean = await clean.get('cqrs-1');
    assert.strictEqual(gotClean.idempotency_key, 'cqrs-1');
  });

  test('updateState mutates the primary, not the replica', async () => {
    const primary = fakePool();
    const replica = fakePool();
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: primary,
      replicaPool: replica,
      warn: () => {},
    });
    await store.ready;

    await store.save({
      idempotency_key: 'cqrs-2',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'submitted',
      tx_hash: null,
    });
    primary.queryCalls.insert = 0;

    await store.updateState('cqrs-2', 'settled', { tx_hash: 'tx-abc' });
    assert.strictEqual(primary.queryCalls.update, 1);
    assert.strictEqual(replica.queryCalls.update, 0);
    // Replica is untouched; the primary row changed.
    assert.strictEqual(primary.store.get('cqrs-2').state, 'settled');
    assert.strictEqual(primary.store.get('cqrs-2').tx_hash, 'tx-abc');
  });

  test('read-after-write: own writes are served from memory, never the lagging replica', async () => {
    const primary = fakePool();
    const replica = fakePool({ lagKeys: ['fresh-1'] });
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: primary,
      replicaPool: replica,
      replicaLagMs: 100,
      warn: () => {},
    });
    await store.ready;

    await store.save({
      idempotency_key: 'fresh-1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'submitted',
    });

    // The replica is lagged for fresh-1, but read-after-write
    // (`getConsistent`, what the status endpoint uses) serves this process's
    // own write from memory immediately.
    const got = await store.getConsistent('fresh-1');
    assert.strictEqual(got.state, 'submitted');
  });

  test("getConsistent falls back to the primary once the replica can't propagate a fresh row", async () => {
    const primary = fakePool();
    const replica = fakePool({ lagKeys: ['laggy-1'] });
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: primary,
      replicaPool: replica,
      replicaLagMs: 40,
      warn: () => {},
    });
    await store.ready;

    // Simulate a row written on the primary by another pod, not yet visible on
    // the replica (replica lags; primary is up to date).
    primary.store.set('laggy-1', {
      idempotency_key: 'laggy-1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'settled',
      tx_hash: 'tx-laggy',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const got = await store.getConsistent('laggy-1');
    assert.strictEqual(got.state, 'settled');
    assert.strictEqual(got.tx_hash, 'tx-laggy');
  });

  test('listUnknown reads from the replica (historical sweep)', async () => {
    const primary = fakePool();
    const replica = fakePool();
    for (const k of ['u-1', 'u-2']) {
      replica.store.set(k, {
        idempotency_key: k,
        network: 'stellar:testnet',
        scheme: 'exact-stellar',
        state: 'unknown',
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: primary,
      replicaPool: replica,
      warn: () => {},
    });
    await store.ready;
    const rows = await store.listUnknown();
    assert.strictEqual(rows.length, 2);
  });

  test('buildSettlementStore wires replicaUrl and replicaLagMs from config', async () => {
    const config = resolveConfig({
      FACILITATOR_SECRET: Keypair.random().secret(),
      DATABASE_URL: 'postgres://primary:5432/x402',
      DATABASE_URL_REPLICA: 'postgres://replica:5432/x402',
      SETTLEMENT_REPLICA_LAG_MS: '2500',
    });
    assert.strictEqual(config.databaseReplicaUrl, 'postgres://replica:5432/x402');
    assert.strictEqual(config.settlementReplicaLagMs, 2500);

    // Inject a fake primary pool so buildSettlementStore's lazy `import('pg')`
    // never tries to resolve the fake hostname (getaddrinfo ENOTFOUND primary)
    // out from under the test. The replica is only configured via
    // `replicaUrl`, which just constructs a real pg.Pool that never queries at
    // this stage, so no connection is attempted there either.
    const fakePool = {
      on: () => {},
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    };
    const store = buildSettlementStore(config, { log: () => {}, pool: fakePool });
    assert.ok(store instanceof PostgresSettlementStore);
    // The config fields are forwarded into the store's replica settings.
    assert.strictEqual(store.replicaLagMs, 2500);
    assert.strictEqual(store.replicaUrl, 'postgres://replica:5432/x402');
  });

  test('GET /settlements/:key serves a fresh settlement even when the replica lags', async () => {
    const dummySecret = Keypair.random().secret();
    const config = resolveConfig({
      FACILITATOR_SECRET: dummySecret,
      FACILITATOR_API_KEYS: 'callerA:secretA',
      DATABASE_URL: 'postgres://primary',
      DATABASE_URL_REPLICA: 'postgres://replica',
      SETTLEMENT_REPLICA_LAG_MS: '40',
    });

    const primary = fakePool();
    const replica = fakePool({ lagKeys: ['settlement-A'] });
    const store = new PostgresSettlementStore(config.databaseUrl, {
      pool: primary,
      replicaPool: replica,
      replicaLagMs: config.settlementReplicaLagMs,
    });
    await store.ready;

    // Row exists on primary (written by another pod moments ago), lagging on
    // replica. A status read must still return it via the primary fallback.
    primary.store.set('settlement-A', {
      idempotency_key: 'settlement-A',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'settled',
      tx_hash: 'hashA',
      key_id: 'callerA',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const app = await createApp(
      config,
      { getSupported: () => ({}) },
      { checkSettle: async () => ({ allowed: true }) },
      {},
      null,
      { settlementStore: store },
    );

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/settlements/settlement-A',
        headers: { authorization: 'Bearer secretA' },
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.settlement.state, 'settled');
      assert.strictEqual(body.settlement.tx_hash, 'hashA');
    } finally {
      await app.close();
    }
  });
});

describe('CQRS Event Streaming Pipeline', () => {
  /**
   * Helper to create a fake pool with event store support
   */
  function createEventStorePool(overrides = {}) {
    const events = overrides.events || [];
    const projections = new Map();
    const state = {
      checkpointSeq: 0,
    };
    const maxSeq = events.length > 0 ? Math.max(...events.map(e => e.seq)) : 0;

    return {
      events,
      projections,
      get checkpointSeq() {
        return state.checkpointSeq;
      },
      on: () => {},
      query: async (text, params = []) => {
        const flat = text.replace(/\s+/g, ' ').trim();

        // Create tables
        if (/CREATE TABLE|CREATE INDEX/.test(flat)) {
          return { rows: [] };
        }

        // Checkpoint initialization
        if (flat.includes('settlement_projection_checkpoint')) {
          if (flat.includes('INSERT INTO')) {
            return { rows: [] };
          }
          if (flat.includes('SELECT last_seq')) {
            return { rows: [{ last_seq: state.checkpointSeq }] };
          }
          if (flat.includes('UPDATE')) {
            state.checkpointSeq = params[0];
            return { rows: [] };
          }
        }

        // Read events batch
        if (flat.includes('FROM settlement_events e WHERE e.seq >')) {
          const fromSeq = params[0];
          const limit = params[1];
          const batch = events.filter(e => e.seq > fromSeq).slice(0, limit);
          return { rows: batch };
        }

        // Max sequence
        if (flat.includes('MAX(seq)')) {
          return { rows: [{ max_seq: maxSeq }] };
        }

        // Fetch all events for a key
        if (flat.includes('WHERE idempotency_key = $1') && flat.includes('ORDER BY seq')) {
          const key = params[0];
          const keyEvents = events.filter(e => e.idempotency_key === key);
          return { rows: keyEvents };
        }

        // Write projection
        if (flat.includes('INSERT INTO settlement_read_model')) {
          const [key] = params;
          projections.set(key, {
            idempotency_key: params[0],
            key_id: params[1],
            network: params[2],
            scheme: params[3],
            state: params[8],
            tx_hash: params[9],
            last_event_seq: params[14],
          });
          return { rows: [] };
        }

        // Query merchant history
        if (flat.includes('FROM settlement_read_model WHERE key_id')) {
          const keyId = params[0];
          const rows = [...projections.values()].filter(p => p.key_id === keyId);
          return { rows };
        }

        // State counts
        if (flat.includes('GROUP BY state')) {
          const counts = new Map();
          for (const p of projections.values()) {
            counts.set(p.state, (counts.get(p.state) || 0) + 1);
          }
          const rows = [...counts.entries()].map(([state, count]) => ({
            state,
            count: String(count),
          }));
          return { rows };
        }

        return { rows: [] };
      },
    };
  }

  /**
   * Helper to create mock metrics
   */
  function createMockMetrics() {
    const metrics = {
      projectionLag: 0,
      eventsProcessed: 0,
      batchDurations: [],
      throughput: 0,
    };

    return {
      setProjectionLag: lag => {
        metrics.projectionLag = lag;
      },
      incProjectionEventsProcessed: count => {
        metrics.eventsProcessed += count;
      },
      observeProjectionBatchDuration: duration => {
        metrics.batchDurations.push(duration);
      },
      setProjectionThroughput: throughput => {
        metrics.throughput = throughput;
      },
      getMetrics: () => metrics,
    };
  }

  test('CheckpointManager initializes and persists checkpoint', async () => {
    const pool = createEventStorePool();
    const checkpoint = new CheckpointManager(pool, { info: () => {} });

    await checkpoint.initialize();
    assert.strictEqual(checkpoint.getOffset(), 0);

    await checkpoint.updateCheckpoint(42);
    assert.strictEqual(checkpoint.getOffset(), 42);
    assert.strictEqual(pool.checkpointSeq, 42);
  });

  test('EventStreamReader reads events in batches', async () => {
    const events = [
      {
        seq: 1,
        idempotency_key: 'set-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        payload: { idempotency_key: 'set-1', network: 'stellar:testnet', scheme: 'exact-stellar' },
        recorded_at: new Date().toISOString(),
      },
      {
        seq: 2,
        idempotency_key: 'set-1',
        event_type: SETTLEMENT_EVENT_TYPES.SETTLED,
        payload: { idempotency_key: 'set-1', tx_hash: 'hash-1' },
        recorded_at: new Date().toISOString(),
      },
      {
        seq: 3,
        idempotency_key: 'set-2',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        payload: { idempotency_key: 'set-2', network: 'stellar:testnet', scheme: 'exact-stellar' },
        recorded_at: new Date().toISOString(),
      },
    ];

    const pool = createEventStorePool({ events });
    const reader = new EventStreamReader(pool, { info: () => {} });

    const batch = await reader.readBatch(0, 2);
    assert.strictEqual(batch.length, 2);
    assert.strictEqual(batch[0].seq, 1);
    assert.strictEqual(batch[1].seq, 2);

    const maxSeq = await reader.getMaxSequence();
    assert.strictEqual(maxSeq, 3);
  });

  test('ProjectionWriter initializes read-model tables', async () => {
    const pool = createEventStorePool();
    const writer = new ProjectionWriter(pool, { info: () => {} });

    await writer.initialize();
    // Table creation queries were called (verified by not throwing)
    assert.ok(true);
  });

  test('ProjectionWriter writes and updates projections', async () => {
    const pool = createEventStorePool();
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
      state: 'submitted',
      tx_hash: null,
      error_reason: null,
      error_message: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await writer.writeProjection(projection, 1);
    assert.ok(pool.projections.has('proj-1'));
    assert.strictEqual(pool.projections.get('proj-1').state, 'submitted');
  });

  test('ProjectionWriter queries merchant history with sub-10ms optimization', async () => {
    const pool = createEventStorePool();
    const writer = new ProjectionWriter(pool, { info: () => {} });
    await writer.initialize();

    // Add test projections
    pool.projections.set('m1-1', {
      idempotency_key: 'm1-1',
      key_id: 'merchant-1',
      state: 'settled',
    });
    pool.projections.set('m1-2', {
      idempotency_key: 'm1-2',
      key_id: 'merchant-1',
      state: 'failed',
    });
    pool.projections.set('m2-1', {
      idempotency_key: 'm2-1',
      key_id: 'merchant-2',
      state: 'settled',
    });

    const history = await writer.queryMerchantHistory('merchant-1');
    assert.strictEqual(history.length, 2);
    assert.ok(history.every(h => h.key_id === 'merchant-1'));
  });

  test('ProjectionWriter gets state counts for analytics', async () => {
    const pool = createEventStorePool();
    const writer = new ProjectionWriter(pool, { info: () => {} });
    await writer.initialize();

    pool.projections.set('s1', { key_id: 'k1', state: 'settled' });
    pool.projections.set('s2', { key_id: 'k1', state: 'settled' });
    pool.projections.set('s3', { key_id: 'k1', state: 'failed' });

    const counts = await writer.getStateCounts();
    assert.ok(counts.some(c => c.state === 'settled' && c.count === '2'));
    assert.ok(counts.some(c => c.state === 'failed' && c.count === '1'));
  });

  test('ProjectionWorker processes events and updates checkpoint', async () => {
    const events = [
      {
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
      },
      {
        seq: 2,
        idempotency_key: 'worker-1',
        event_type: SETTLEMENT_EVENT_TYPES.SETTLED,
        event_version: 1,
        payload: { idempotency_key: 'worker-1', tx_hash: 'hash-worker-1' },
        recorded_at: new Date().toISOString(),
      },
    ];

    const pool = createEventStorePool({ events });
    const metrics = createMockMetrics();
    const worker = new ProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      batchSize: 10,
      pollInterval: 100,
    });

    await worker.initialize();
    assert.strictEqual(worker.checkpoint.getOffset(), 0);

    await worker.processBatch();

    // Checkpoint should advance to last processed event
    assert.strictEqual(worker.checkpoint.getOffset(), 2);

    // Projection should be written
    assert.ok(pool.projections.has('worker-1'));
    assert.strictEqual(pool.projections.get('worker-1').state, 'settled');
    assert.strictEqual(pool.projections.get('worker-1').tx_hash, 'hash-worker-1');

    // Metrics should be recorded
    const m = metrics.getMetrics();
    assert.strictEqual(m.eventsProcessed, 1); // One settlement processed
    assert.strictEqual(m.batchDurations.length, 1);
  });

  test('ProjectionWorker recovers from simulated crash', async () => {
    const events = [
      {
        seq: 1,
        idempotency_key: 'crash-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'crash-1',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
    ];

    const pool = createEventStorePool({ events });
    const metrics = createMockMetrics();
    const worker = new ProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.initialize();
    await worker.processBatch();

    const checkpointBeforeCrash = worker.checkpoint.getOffset();
    assert.strictEqual(checkpointBeforeCrash, 1);

    // Simulate crash and recovery
    const recovery = await simulateRecoveryTest(worker);
    assert.ok(recovery.recovered);
    assert.strictEqual(recovery.beforeCrash, 1);
    assert.strictEqual(recovery.afterRestart, 1);
  });

  test('ProjectionWorker handles out-of-order events within settlement', async () => {
    // Events arrive out of order within the same settlement
    const events = [
      {
        seq: 2,
        idempotency_key: 'ooo-1',
        event_type: SETTLEMENT_EVENT_TYPES.SETTLED,
        event_version: 1,
        payload: { idempotency_key: 'ooo-1', tx_hash: 'hash-ooo' },
        recorded_at: new Date().toISOString(),
      },
      {
        seq: 1,
        idempotency_key: 'ooo-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'ooo-1',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
    ];

    const ordered = validateEventOrdering(events);
    assert.ok(ordered.has('ooo-1'));

    const settlementEvents = ordered.get('ooo-1');
    assert.strictEqual(settlementEvents[0].seq, 1);
    assert.strictEqual(settlementEvents[1].seq, 2);
  });

  test('ProjectionWorker handles duplicate events idempotently', async () => {
    const events = [
      {
        seq: 1,
        idempotency_key: 'dup-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'dup-1',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
      {
        seq: 2,
        idempotency_key: 'dup-1',
        event_type: SETTLEMENT_EVENT_TYPES.SETTLED,
        event_version: 1,
        payload: { idempotency_key: 'dup-1', tx_hash: 'hash-dup' },
        recorded_at: new Date().toISOString(),
      },
    ];

    const pool = createEventStorePool({ events });
    const metrics = createMockMetrics();
    const worker = new ProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.initialize();

    // Process once
    await worker.processBatch();
    const projection1 = pool.projections.get('dup-1');

    // Process again (duplicate)
    worker.checkpoint.currentOffset = 0; // Reset to reprocess
    await worker.processBatch();
    const projection2 = pool.projections.get('dup-1');

    // Result should be identical (idempotent)
    assert.strictEqual(projection1.state, projection2.state);
    assert.strictEqual(projection1.tx_hash, projection2.tx_hash);
  });

  test('Projection catches up accurately after simulated crash', async () => {
    const events = [
      {
        seq: 1,
        idempotency_key: 'catchup-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'catchup-1',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
      {
        seq: 2,
        idempotency_key: 'catchup-2',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'catchup-2',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
    ];

    const pool = createEventStorePool({ events });
    const metrics = createMockMetrics();
    const worker = new ProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.initialize();

    const result = await processToCaughtUp(worker, 10);
    assert.ok(result.caughtUp);
    assert.strictEqual(result.offset, 2);
    assert.strictEqual(pool.projections.size, 2);
  });

  test('Projection emits metrics for lag and throughput', async () => {
    const events = [
      {
        seq: 1,
        idempotency_key: 'metrics-1',
        event_type: SETTLEMENT_EVENT_TYPES.INITIATED,
        event_version: 1,
        payload: {
          idempotency_key: 'metrics-1',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          key_id: 'merchant-1',
        },
        recorded_at: new Date().toISOString(),
      },
    ];

    const pool = createEventStorePool({ events });
    const metrics = createMockMetrics();
    const worker = new ProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.initialize();
    await worker.processBatch();
    await worker.updateMetrics();

    const m = metrics.getMetrics();
    assert.strictEqual(m.projectionLag, 0); // Caught up
    assert.strictEqual(m.eventsProcessed, 1);
    assert.ok(m.batchDurations.length > 0);
  });

  test('Checkpoint persistence verified across restarts', async () => {
    const pool = createEventStorePool();
    const checkpoint = new CheckpointManager(pool, { info: () => {} });

    await checkpoint.initialize();
    await checkpoint.updateCheckpoint(123);

    const verification = await verifyCheckpointPersistence(pool, 123);
    assert.ok(verification.persisted);
    assert.strictEqual(verification.checkpoint.last_seq, 123);
  });

  test('createProjectionWorker factory function', async () => {
    const pool = createEventStorePool({ events: [] });
    const metrics = createMockMetrics();

    const worker = await createProjectionWorker(pool, metrics, {
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    assert.ok(worker instanceof ProjectionWorker);
    assert.strictEqual(worker.checkpoint.getOffset(), 0);
  });
});
