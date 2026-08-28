import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresSettlementStore } from '../src/store/postgres.js';
import { buildSettlementStore } from '../src/store/index.js';
import { resolveConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { Keypair } from '@stellar/stellar-sdk';

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
    assert.equal(saved.state, 'submitted');
    assert.equal(primary.queryCalls.insert, 1);
    assert.equal(replica.queryCalls.insert, 0);

    // Seed the replica (as replication would) and read from it.
    replica.store.set('cqrs-1', { ...saved, updated_at: new Date() });
    const got = await store.get('cqrs-1');
    assert.equal(got.idempotency_key, 'cqrs-1');
    // The in-memory fallback is authoritative for our own write, so force a
    // clean store where the row only exists on the replica.
    const clean = new PostgresSettlementStore('postgres://primary', {
      pool: primary,
      replicaPool: replica,
      warn: () => {},
    });
    await clean.ready;
    const gotClean = await clean.get('cqrs-1');
    assert.equal(gotClean.idempotency_key, 'cqrs-1');
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
    assert.equal(primary.queryCalls.update, 1);
    assert.equal(replica.queryCalls.update, 0);
    // Replica is untouched; the primary row changed.
    assert.equal(primary.store.get('cqrs-2').state, 'settled');
    assert.equal(primary.store.get('cqrs-2').tx_hash, 'tx-abc');
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
    assert.equal(got.state, 'submitted');
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
    assert.equal(got.state, 'settled');
    assert.equal(got.tx_hash, 'tx-laggy');
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
    assert.equal(rows.length, 2);
  });

  test('buildSettlementStore wires replicaUrl and replicaLagMs from config', async () => {
    const config = resolveConfig({
      FACILITATOR_SECRET: Keypair.random().secret(),
      DATABASE_URL: 'postgres://primary:5432/x402',
      DATABASE_URL_REPLICA: 'postgres://replica:5432/x402',
      SETTLEMENT_REPLICA_LAG_MS: '2500',
    });
    assert.equal(config.databaseReplicaUrl, 'postgres://replica:5432/x402');
    assert.equal(config.settlementReplicaLagMs, 2500);

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
    assert.equal(store.replicaLagMs, 2500);
    assert.equal(store.replicaUrl, 'postgres://replica:5432/x402');
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

    const app = createApp(
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
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.equal(body.settlement.state, 'settled');
      assert.equal(body.settlement.tx_hash, 'hashA');
    } finally {
      await app.close();
    }
  });
});
