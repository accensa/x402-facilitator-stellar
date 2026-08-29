/**
 * Event-sourced settlement state machine (#130).
 *
 * The settlement store no longer overwrites a row in place: every transition
 * is an appended event, and the current state read back by `get`/`listUnknown`
 * is a projection folded over that stream. These tests pin:
 *   - the event log itself (types, ordering, that a retry appends rather than
 *     mutates)
 *   - that the projection matches what a fold over the raw events produces
 *   - the audit-log export surface, both the store method and the HTTP route
 *   - the Postgres-backed store issuing the same event-then-projection writes
 *     against a fake pool that mirrors the real schema
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { MemorySettlementStore } from '../src/store/memory.js';
import { PostgresSettlementStore } from '../src/store/postgres.js';
import { projectSettlement } from '../src/eventstore/projection.js';
import { createApp } from '../src/app.js';
import { resolveConfig } from '../src/config.js';

describe('Event-sourced settlement store (#130)', () => {
  test('save() appends a SettlementInitiated event, not a row write', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      state: 'submitted',
      tx_hash: 'hash1',
    });

    const log = await store.getEventLog('k1');
    assert.equal(log.length, 1);
    assert.equal(log[0].event_type, 'SettlementInitiated');
    assert.equal(log[0].seq, 1);
    assert.equal(log[0].payload.tx_hash, 'hash1');
  });

  test('updateState() appends a terminal event; the record is never mutated in place', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });
    await store.updateState('k1', 'settled', { tx_hash: 'hash1', response: { success: true } });

    const log = await store.getEventLog('k1');
    assert.equal(log.length, 2);
    assert.equal(log[0].event_type, 'SettlementInitiated');
    assert.equal(log[1].event_type, 'SettlementSettled');
    assert.equal(log[1].seq, 2);

    const rec = await store.get('k1');
    assert.equal(rec.state, 'settled');
    assert.equal(rec.tx_hash, 'hash1');
  });

  test('updateState() on a key with no prior event is a no-op, not a fabricated event', async () => {
    const store = new MemorySettlementStore();
    const result = await store.updateState('never-seen', 'settled', {});
    assert.equal(result, null);
    assert.deepEqual(await store.getEventLog('never-seen'), []);
  });

  test('a retryable-failure retry appends a new Initiated event instead of rewriting history', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      tx_hash: 'first-attempt-hash',
    });
    await store.updateState('k1', 'failed', {
      error_reason: 'soroban_rpc_unreachable',
      error_message: 'rpc down',
    });

    // App-level retry: same idempotency key, fresh attempt.
    await store.save({
      idempotency_key: 'k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });

    const log = await store.getEventLog('k1');
    assert.equal(log.length, 3);
    assert.deepEqual(
      log.map(e => e.event_type),
      ['SettlementInitiated', 'SettlementFailed', 'SettlementInitiated'],
    );

    const rec = await store.get('k1');
    assert.equal(rec.state, 'submitted');
    assert.equal(rec.tx_hash, null); // reset by the fresh Initiated, exactly as the old error/tx fields were
    assert.equal(rec.error_reason, null);
    // created_at is the *first* event's timestamp, not the retry's.
    assert.equal(rec.created_at, log[0].recorded_at);
  });

  test('the projection returned by get() is exactly a fold over the raw event log', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      payer: 'GPAYER',
      pay_to: 'GPAYTO',
      asset: 'USDC',
      amount: '1000000',
    });
    await store.updateState('k1', 'unknown', { error_reason: 'submitted_outcome_unknown' });
    await store.updateState('k1', 'settled', { tx_hash: 'hash-final' });

    const log = await store.getEventLog('k1');
    const rebuilt = projectSettlement(log);
    const read = await store.get('k1');
    assert.deepEqual(rebuilt, read);
    assert.equal(read.state, 'settled');
    assert.equal(read.tx_hash, 'hash-final');
  });

  test('listUnknown() reflects the projection, not a stale write', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });
    await store.updateState('k1', 'unknown', { error_reason: 'submitted_outcome_unknown' });
    assert.equal((await store.listUnknown()).length, 1);

    await store.updateState('k1', 'settled', {});
    assert.equal((await store.listUnknown()).length, 0);
  });

  test('exportAuditLog() returns every transition across every settlement, in order', async () => {
    const store = new MemorySettlementStore();
    await store.save({ idempotency_key: 'a', network: 'stellar:testnet', scheme: 'exact-stellar' });
    await store.save({ idempotency_key: 'b', network: 'stellar:testnet', scheme: 'exact-stellar' });
    await store.updateState('a', 'settled', {});
    await store.updateState('b', 'failed', { error_reason: 'facilitator_error' });

    const all = await store.exportAuditLog();
    assert.equal(all.length, 4);
    // Chronological, not grouped by key.
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1].recorded_at <= all[i].recorded_at);
    }
    const limited = await store.exportAuditLog({ limit: 2 });
    assert.equal(limited.length, 2);
  });

  test('rebuildProjection() reconstructs identical state from the event log alone', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'k1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });
    await store.updateState('k1', 'failed', { error_reason: 'rate_limited' });

    const before = await store.get('k1');
    const rebuilt = await store.rebuildProjection('k1');
    assert.deepEqual(rebuilt, before);
  });
});

describe('GET /settlements/:idempotencyKey/events (#130)', () => {
  function buildApp(store) {
    const dummySecret = Keypair.random().secret();
    const config = resolveConfig({
      FACILITATOR_SECRET: dummySecret,
      FACILITATOR_API_KEYS: 'callerA:secretA,callerB:secretB',
    });
    return createApp(
      config,
      { getSupported: () => ({}) },
      { checkSettle: async () => ({ allowed: true }) },
      {},
      null,
      { settlementStore: store },
    );
  }

  test('returns the full ordered event history for the owning caller', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'settlement-A',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      key_id: 'callerA',
    });
    await store.updateState('settlement-A', 'settled', { tx_hash: 'hashA' });

    const app = buildApp(store);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/settlements/settlement-A/events',
        headers: { authorization: 'Bearer secretA' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.equal(body.events.length, 2);
      assert.deepEqual(
        body.events.map(e => e.event_type),
        ['SettlementInitiated', 'SettlementSettled'],
      );
    } finally {
      await app.close();
    }
  });

  test('404s for a caller who does not own the settlement', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'settlement-A',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      key_id: 'callerA',
    });

    const app = buildApp(store);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/settlements/settlement-A/events',
        headers: { authorization: 'Bearer secretB' },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  test('404s for an unknown settlement', async () => {
    const store = new MemorySettlementStore();
    const app = buildApp(store);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/settlements/does-not-exist/events',
        headers: { authorization: 'Bearer secretA' },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe('PostgresSettlementStore event sourcing against a fake pool (#130)', () => {
  test('save/updateState/get/listUnknown/getEventLog round-trip through events + projection', async () => {
    const pool = fakePostgresPool();
    const store = new PostgresSettlementStore('postgres://unused', { pool });

    await store.save({
      idempotency_key: 'pg-1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      payer: 'GPAYER',
      pay_to: 'GPAYTO',
      asset: 'USDC',
      amount: '1000000',
      tx_hash: 'submit-hash',
      key_id: 'callerA',
    });

    let rec = await store.get('pg-1');
    assert.equal(rec.state, 'submitted');
    assert.equal(rec.tx_hash, 'submit-hash');
    assert.equal(rec.version, 1);

    await store.updateState('pg-1', 'unknown', { error_reason: 'submitted_outcome_unknown' });
    assert.equal((await store.listUnknown()).length, 1);

    await store.updateState('pg-1', 'settled', { tx_hash: 'final-hash' });
    rec = await store.get('pg-1');
    assert.equal(rec.state, 'settled');
    assert.equal(rec.tx_hash, 'final-hash');
    assert.equal(rec.version, 3);
    assert.equal((await store.listUnknown()).length, 0);

    const log = await store.getEventLog('pg-1');
    assert.deepEqual(
      log.map(e => e.event_type),
      ['SettlementInitiated', 'SettlementOutcomeUnknown', 'SettlementSettled'],
    );
    assert.deepEqual(
      log.map(e => e.seq),
      [1, 2, 3],
    );
  });

  test('updateState() on an unknown key never appends an orphan event', async () => {
    const pool = fakePostgresPool();
    const store = new PostgresSettlementStore('postgres://unused', { pool });

    const result = await store.updateState('never-seen', 'settled', {});
    assert.equal(result, null);
    assert.equal(pool.events.length, 0);
  });

  test('exportAuditLog() exposes the append-only log across aggregates', async () => {
    const pool = fakePostgresPool();
    const store = new PostgresSettlementStore('postgres://unused', { pool });

    await store.save({ idempotency_key: 'a', network: 'stellar:testnet', scheme: 'exact-stellar' });
    await store.save({ idempotency_key: 'b', network: 'stellar:testnet', scheme: 'exact-stellar' });
    await store.updateState('a', 'settled', {});

    const all = await store.exportAuditLog({});
    assert.equal(all.length, 3);
  });

  test('rebuildProjection() replays the event log and reproduces the live projection', async () => {
    const pool = fakePostgresPool();
    const store = new PostgresSettlementStore('postgres://unused', { pool });

    await store.save({
      idempotency_key: 'pg-2',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });
    await store.updateState('pg-2', 'failed', {
      error_reason: 'rate_limited',
      error_message: 'slow down',
    });

    const live = await store.get('pg-2');

    // Simulate read-model corruption/loss: the events table is untouched.
    pool.projections.delete('pg-2');
    assert.equal(await store.get('pg-2'), null);

    const rebuilt = await store.rebuildProjection('pg-2');
    assert.equal(rebuilt.state, live.state);
    assert.equal(rebuilt.error_reason, live.error_reason);
    assert.equal(rebuilt.error_message, live.error_message);

    // The repaired read model serves get() again.
    const readAfterRepair = await store.get('pg-2');
    assert.equal(readAfterRepair.state, 'failed');
  });

  test('a retry after a retryable failure appends rather than overwrites, same as the memory store', async () => {
    const pool = fakePostgresPool();
    const store = new PostgresSettlementStore('postgres://unused', { pool });

    await store.save({
      idempotency_key: 'pg-3',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      tx_hash: 'h1',
    });
    await store.updateState('pg-3', 'failed', { error_reason: 'lock_timeout' });
    await store.save({
      idempotency_key: 'pg-3',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });

    const log = await store.getEventLog('pg-3');
    assert.deepEqual(
      log.map(e => e.event_type),
      ['SettlementInitiated', 'SettlementFailed', 'SettlementInitiated'],
    );
    const rec = await store.get('pg-3');
    assert.equal(rec.state, 'submitted');
    assert.equal(rec.tx_hash, null);
    assert.equal(rec.error_reason, null);
  });
});

/**
 * A minimal emulation of the pg Pool surface, implementing exactly the
 * statements PostgresSettlementStore issues: an append to settlement_events
 * paired with the projection write derived from it. This pins the SQL's
 * semantics (atomic append + projection upsert, COALESCE-preserved fields on
 * a partial update, seq/version derivation) without a live database.
 */
function fakePostgresPool() {
  const events = [];
  const projections = new Map();

  function nextSeq(key) {
    const seqs = events.filter(e => e.idempotency_key === key).map(e => e.seq);
    return seqs.length ? Math.max(...seqs) + 1 : 1;
  }

  return {
    events,
    projections,
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (norm.includes('CREATE TABLE') || norm.includes('CREATE INDEX')) {
        // settlement_events/settlement_projections from #130, plus the
        // outbox_events table the store now creates alongside them (#123).
        return { rows: [] };
      }

      if (norm.includes("'SettlementInitiated'")) {
        const [key, payloadJson, network, scheme, payer, payTo, asset, amount, txHash, keyId] =
          params;
        const seq = nextSeq(key);
        const recordedAt = new Date(Date.now() + events.length).toISOString();
        events.push({
          idempotency_key: key,
          seq,
          event_type: 'SettlementInitiated',
          event_version: 1,
          payload: JSON.parse(payloadJson),
          recorded_at: recordedAt,
        });
        const existing = projections.get(key);
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
          version: seq,
          created_at: existing?.created_at ?? recordedAt,
          updated_at: recordedAt,
        };
        projections.set(key, row);
        return { rows: [{ ...row }] };
      }

      if (
        norm.includes('WHERE settlement_projections.idempotency_key = ins_event.idempotency_key')
      ) {
        const [key, eventType, payloadJson, state, txHash, errorReason, errorMessage, response] =
          params;
        const existing = projections.get(key);
        if (!existing) return { rows: [] };
        const seq = nextSeq(key);
        const recordedAt = new Date(Date.now() + events.length).toISOString();
        events.push({
          idempotency_key: key,
          seq,
          event_type: eventType,
          event_version: 1,
          payload: JSON.parse(payloadJson),
          recorded_at: recordedAt,
        });
        const row = {
          ...existing,
          state,
          tx_hash: txHash ?? existing.tx_hash,
          error_reason: errorReason ?? existing.error_reason,
          error_message: errorMessage ?? existing.error_message,
          response: response ? JSON.parse(response) : existing.response,
          version: seq,
          updated_at: recordedAt,
        };
        projections.set(key, row);
        return { rows: [{ ...row }] };
      }

      if (
        norm.startsWith('SELECT') &&
        norm.includes('FROM settlement_projections WHERE idempotency_key = $1')
      ) {
        const [key] = params;
        const row = projections.get(key);
        return { rows: row ? [{ ...row }] : [] };
      }

      if (norm.includes('FROM settlement_projections WHERE state = $1')) {
        const [state] = params;
        return {
          rows: [...projections.values()].filter(r => r.state === state).map(r => ({ ...r })),
        };
      }

      if (norm.includes('FROM settlement_events WHERE idempotency_key = $1 ORDER BY seq ASC')) {
        const [key] = params;
        return {
          rows: events
            .filter(e => e.idempotency_key === key)
            .sort((a, b) => a.seq - b.seq)
            .map(e => ({ ...e })),
        };
      }

      if (norm.includes('($1::timestamptz IS NULL OR recorded_at >= $1)')) {
        const [since, until, limit] = params;
        let filtered = [...events].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
        if (since) filtered = filtered.filter(e => e.recorded_at >= since);
        if (until) filtered = filtered.filter(e => e.recorded_at <= until);
        return { rows: filtered.slice(0, limit ?? filtered.length).map(e => ({ ...e })) };
      }

      if (
        norm.startsWith('INSERT INTO settlement_projections (') &&
        norm.includes('VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)')
      ) {
        const [
          key,
          network,
          scheme,
          payer,
          payTo,
          asset,
          amount,
          state,
          txHash,
          errorReason,
          errorMessage,
          response,
          keyId,
          version,
          createdAt,
          updatedAt,
        ] = params;
        const row = {
          idempotency_key: key,
          network,
          scheme,
          payer,
          pay_to: payTo,
          asset,
          amount,
          state,
          tx_hash: txHash,
          error_reason: errorReason,
          error_message: errorMessage,
          response: response ? JSON.parse(response) : null,
          key_id: keyId,
          version,
          created_at: createdAt,
          updated_at: updatedAt,
        };
        projections.set(key, row);
        return { rows: [{ ...row }] };
      }

      throw new Error(`fakePostgresPool: unrecognized statement: ${norm.slice(0, 120)}`);
    },
  };
}
