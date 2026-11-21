/**
 * Concurrent settlement writes must not race on `MAX(seq)` (#726).
 *
 * `save` and `updateState` used to compute `COALESCE(MAX(seq), 0) + 1` without
 * serializing writers for the same idempotency key. Two in-flight writes could
 * both read the same max and insert the same `seq`, tripping
 * `UNIQUE (idempotency_key, seq)`; the store caught that and degraded the whole
 * process to its in-memory fallback.
 *
 * The store now takes a transaction-scoped advisory lock per key before the
 * sequence is computed (and `updateState` additionally locks the projection
 * row). These tests drive simultaneous writers through a pool double that
 * emulates Postgres lock blocking, and assert that every write commits with a
 * contiguous sequence and nothing degrades.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresSettlementStore } from '../src/store/postgres.js';

const SEQ_LOCK = 'pg_advisory_xact_lock';
const ROW_LOCK = 'FOR UPDATE';

/**
 * A pg-shaped pool double with transaction-aware per-key locks. A lock is a
 * promise gate: a second transaction for the same key waits on the first
 * transaction's COMMIT/ROLLBACK, exactly as `pg_advisory_xact_lock` /
 * `SELECT ... FOR UPDATE` make it wait in Postgres. Data statements only run
 * once the lock is held, so they see the previous writer's committed rows.
 *
 * `options` marks this as a real transactional pool so the store takes the
 * locking path (see `PostgresSettlementStore#_supportsTransactions`).
 */
function serializedPool() {
  const events = [];
  const projections = new Map();
  const lockTails = new Map();
  const stats = { begins: 0, commits: 0, rollbacks: 0, seqLocks: 0, rowLocks: 0 };

  function acquire(key) {
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    lockTails.set(
      key,
      previous.then(() => gate),
    );
    return previous.then(() => release);
  }

  function nextSeq(key) {
    const seqs = events.filter(e => e.idempotency_key === key).map(e => e.seq);
    return seqs.length ? Math.max(...seqs) + 1 : 1;
  }

  function makeClient() {
    let releaseLock = null;

    function unlock() {
      if (releaseLock) {
        releaseLock();
        releaseLock = null;
      }
    }

    return {
      async query(sql, params = []) {
        const flat = sql.replace(/\s+/g, ' ').trim();

        if (flat === 'BEGIN') {
          stats.begins++;
          return { rows: [] };
        }
        if (flat === 'COMMIT') {
          stats.commits++;
          unlock();
          return { rows: [] };
        }
        if (flat === 'ROLLBACK') {
          stats.rollbacks++;
          unlock();
          return { rows: [] };
        }

        if (flat.includes(SEQ_LOCK)) {
          stats.seqLocks++;
          const key = params[0];
          if (!releaseLock) {
            releaseLock = await acquire(key);
          }
          return { rows: [{ pg_advisory_xact_lock: null }] };
        }

        if (flat.includes(ROW_LOCK)) {
          stats.rowLocks++;
          const key = params[0];
          if (!releaseLock) {
            releaseLock = await acquire(key);
          }
          const row = projections.get(key);
          return { rows: row ? [{ '?column?': 1 }] : [] };
        }

        if (/CREATE TABLE|CREATE INDEX/.test(flat)) return { rows: [] };

        if (flat.includes("'SettlementInitiated'")) {
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
          flat.includes('WHERE settlement_projections.idempotency_key = ins_event.idempotency_key')
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

        if (flat.includes('FROM settlement_events WHERE idempotency_key = $1 ORDER BY seq ASC')) {
          const key = params[0];
          return {
            rows: events
              .filter(e => e.idempotency_key === key)
              .sort((a, b) => a.seq - b.seq)
              .map(e => ({ ...e })),
          };
        }

        if (
          flat.startsWith('SELECT') &&
          flat.includes('FROM settlement_projections WHERE idempotency_key = $1')
        ) {
          const row = projections.get(params[0]);
          return { rows: row ? [{ ...row }] : [] };
        }

        throw new Error(`serializedPool: unexpected statement: ${flat.slice(0, 120)}`);
      },
      release() {},
    };
  }

  return {
    events,
    projections,
    stats,
    // A real pg Pool exposes `options`; the store uses it to recognise a pool
    // that can hold transaction-scoped locks.
    options: { max: 5 },
    on: () => {},
    query: (sql, params = []) => makeClient().query(sql, params),
    connect: async () => makeClient(),
  };
}

function buildStore(pool, warnings) {
  return new PostgresSettlementStore('postgres://unused', {
    pool,
    warn: msg => warnings.push(msg),
  });
}

function spyOnDegrade(store) {
  let calls = 0;
  const original = store._degrade.bind(store);
  store._degrade = message => {
    calls++;
    original(message);
  };
  return () => calls;
}

describe('Concurrent settlement event sequence assignment (#726)', () => {
  test('simultaneous updateState calls produce contiguous sequences without degrading', async () => {
    const pool = serializedPool();
    const warnings = [];
    const store = buildStore(pool, warnings);
    const degradeCalls = spyOnDegrade(store);
    await store.ready;

    await store.save({
      idempotency_key: 'race-update',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });

    const concurrent = 25;
    const results = await Promise.all(
      Array.from({ length: concurrent }, (_, i) =>
        store.updateState('race-update', i % 2 === 0 ? 'settled' : 'unknown', {
          tx_hash: `tx-${i}`,
        }),
      ),
    );

    assert.equal(results.filter(Boolean).length, concurrent, 'every concurrent write succeeded');
    assert.equal(store.degraded, false, 'the store stayed on Postgres');
    assert.equal(degradeCalls(), 0, '_degrade was never called');
    assert.deepEqual(warnings, [], 'no degradation warning was emitted');

    const log = await store.getEventLog('race-update');
    assert.equal(log.length, concurrent + 1);
    assert.deepEqual(
      log.map(e => e.seq),
      Array.from({ length: concurrent + 1 }, (_, i) => i + 1),
      'sequence numbers are 1..N with no gaps or duplicates',
    );
    assert.equal(pool.stats.seqLocks, concurrent + 1, 'every write took the per-key lock');
    assert.equal(pool.stats.rowLocks, concurrent, 'every update locked the projection row');
  });

  test('simultaneous initial save calls allocate contiguous sequences for a new key', async () => {
    const pool = serializedPool();
    const warnings = [];
    const store = buildStore(pool, warnings);
    const degradeCalls = spyOnDegrade(store);
    await store.ready;

    const concurrent = 12;
    const results = await Promise.all(
      Array.from({ length: concurrent }, (_, i) =>
        store.save({
          idempotency_key: 'race-save',
          network: 'stellar:testnet',
          scheme: 'exact-stellar',
          tx_hash: `save-${i}`,
        }),
      ),
    );

    assert.equal(results.length, concurrent);
    assert.equal(store.degraded, false);
    assert.equal(degradeCalls(), 0);
    assert.deepEqual(warnings, []);

    const log = await store.getEventLog('race-save');
    assert.deepEqual(
      log.map(e => e.seq),
      Array.from({ length: concurrent }, (_, i) => i + 1),
      'concurrent initial writes serialize instead of all claiming seq = 1',
    );
    assert.ok(log.every(e => e.event_type === 'SettlementInitiated'));
  });

  test('a transient unique violation is retried without degrading', async () => {
    const pool = serializedPool();
    const warnings = [];
    const store = buildStore(pool, warnings);
    const degradeCalls = spyOnDegrade(store);
    await store.ready;

    const connect = pool.connect.bind(pool);
    let injected = false;
    pool.connect = async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = async (sql, params = []) => {
        if (!injected && sql.includes("'SettlementInitiated'")) {
          injected = true;
          const err = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
        return query(sql, params);
      };
      return client;
    };

    const saved = await store.save({
      idempotency_key: 'retry-23505',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
    });

    assert.equal(injected, true, 'the first attempt hit the simulated conflict');
    assert.equal(saved.idempotency_key, 'retry-23505');
    assert.equal(store.degraded, false, 'a retryable conflict does not degrade the store');
    assert.equal(degradeCalls(), 0);
    assert.deepEqual(warnings, []);

    const log = await store.getEventLog('retry-23505');
    assert.equal(log.length, 1, 'the rolled-back attempt left no partial event');
    assert.equal(log[0].seq, 1);
  });
});
