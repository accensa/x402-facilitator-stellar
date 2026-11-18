/**
 * The Postgres settlement store's in-memory shadow is bounded (#725).
 *
 * `PostgresSettlementStore` mirrors every successful write into the inherited
 * `MemorySettlementStore` event map so `getConsistent` can serve a
 * read-your-own-writes status read without touching a possibly-lagging
 * replica. Historically that mirror was never pruned, so a long-running
 * facilitator accumulated every settlement it had ever handled in heap. These
 * tests pin the bounds — TTL and burst cap — and the invariant that matters
 * more than the bounds: eviction must never turn a read into a wrong answer.
 * Postgres is the source of truth, so an evicted shadow entry falls through to
 * it, and a terminal event for an evicted stream must not project a partial
 * aggregate.
 *
 * The pool doubles below implement exactly the statements the store issues
 * (event append + projection upsert, projection SELECT) and count reads, so a
 * test can tell "answered from the shadow" from "answered by the database".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresSettlementStore } from '../src/store/postgres.js';

const TTL_MS = 60_000;

function fakePool({ lagKeys = [], rejectWrites = null } = {}) {
  const rows = new Map();
  const lag = new Set(lagKeys);
  const counts = { inserts: 0, updates: 0, selects: 0 };

  return {
    rows,
    counts,
    on: () => {},
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };

      // save(): SettlementInitiated CTE — append event + upsert projection.
      if (sql.includes("'SettlementInitiated'")) {
        if (rejectWrites) throw rejectWrites;
        counts.inserts++;
        const [key, , network, scheme, payer, payTo, asset, amount, txHash, keyId] = params;
        const existing = rows.get(key);
        const recordedAt = new Date().toISOString();
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
        rows.set(key, row);
        return { rows: [{ ...row }] };
      }

      // updateState(): event-then-projection CTE.
      if (
        sql.includes('WHERE settlement_projections.idempotency_key = ins_event.idempotency_key')
      ) {
        if (rejectWrites) throw rejectWrites;
        counts.updates++;
        const [key, , , state, txHash, errorReason, errorMessage, response] = params;
        const existing = rows.get(key);
        if (!existing) return { rows: [] };
        const row = {
          ...existing,
          state,
          tx_hash: txHash ?? existing.tx_hash,
          error_reason: errorReason ?? existing.error_reason,
          error_message: errorMessage ?? existing.error_message,
          response: response ? JSON.parse(response) : existing.response,
          version: existing.version + 1,
          updated_at: new Date().toISOString(),
        };
        rows.set(key, row);
        return { rows: [{ ...row }] };
      }

      if (sql.includes('FROM settlement_projections WHERE idempotency_key = $1')) {
        counts.selects++;
        const key = params[0];
        if (lag.has(key)) return { rows: [] };
        const row = rows.get(key);
        return { rows: row ? [{ ...row }] : [] };
      }

      return { rows: [] };
    },
  };
}

function record(key, overrides = {}) {
  return {
    idempotency_key: key,
    network: 'stellar:testnet',
    scheme: 'exact-stellar',
    payer: 'GPAYER',
    pay_to: 'GPAYTO',
    asset: 'USDC',
    amount: '1000000',
    key_id: 'callerA',
    ...overrides,
  };
}

function shadowedStore({ primary, replica, clock, ttl = TTL_MS, cap } = {}) {
  return new PostgresSettlementStore('postgres://primary', {
    pool: primary,
    replicaPool: replica,
    replicaLagMs: 5,
    warn: () => {},
    shadowTtlMs: ttl,
    shadowMaxEntries: cap,
    now: () => clock(),
  });
}

describe('PostgresSettlementStore bounded memory shadow (#725)', () => {
  test('defaults to a 60s consistency window and a finite entry cap', () => {
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: fakePool(),
      warn: () => {},
    });
    assert.equal(store.shadowTtlMs, 60_000);
    assert.equal(store.shadowMaxEntries, 10_000);
  });

  test('getConsistent serves own writes from the shadow inside the window', async () => {
    const primary = fakePool();
    const replica = fakePool({ lagKeys: ['own-1'] });
    const clock = 1_000;
    const store = shadowedStore({ primary, replica, clock: () => clock });
    await store.ready;

    await store.save(record('own-1'));

    const readsBefore = primary.counts.selects + replica.counts.selects;
    const row = await store.getConsistent('own-1');

    assert.equal(row.state, 'submitted');
    assert.equal(row.key_id, 'callerA');
    assert.equal(
      primary.counts.selects + replica.counts.selects,
      readsBefore,
      'the shadow answered without a replica or primary read',
    );
    assert.equal(store.events.has('own-1'), true);
  });

  test('evicts shadow entries older than the window and keeps fresh writes', async () => {
    const primary = fakePool();
    let clock = 1_000;
    const store = shadowedStore({ primary, clock: () => clock });
    await store.ready;

    await store.save(record('old'));
    clock = 31_000;
    await store.save(record('middle'));
    clock = 61_001; // old is 60_001ms stale; middle is 30_001ms fresh
    await store.save(record('new'));

    assert.equal(store.events.has('old'), false, 'stale entry was evicted');
    assert.equal(store.events.has('middle'), true, 'fresh entry was retained');
    assert.equal(store.events.has('new'), true, 'the write that triggered the prune survived');
    assert.equal(store._shadowWrittenAt.size, store.events.size);
  });

  test('an evicted entry falls through to Postgres and still answers correctly', async () => {
    const primary = fakePool();
    let clock = 1_000;
    const store = shadowedStore({ primary, clock: () => clock });
    await store.ready;

    await store.save(record('evicted-1', { key_id: 'callerB' }));
    clock = TTL_MS + 1_001;
    await store.save(record('trigger-prune')); // runs the TTL sweep

    assert.equal(store.events.has('evicted-1'), false);
    const readsBefore = primary.counts.selects;
    const row = await store.getConsistent('evicted-1');

    assert.equal(row.state, 'submitted');
    assert.equal(row.key_id, 'callerB');
    assert.equal(row.network, 'stellar:testnet');
    assert.ok(primary.counts.selects > readsBefore, 'the read went to the database');
  });

  test('a terminal update after eviction does not project a partial aggregate', async () => {
    const primary = fakePool();
    let clock = 1_000;
    const store = shadowedStore({ primary, clock: () => clock });
    await store.ready;

    await store.save(record('late-1', { key_id: 'callerC' }));
    clock = TTL_MS + 1_001;

    const updated = await store.updateState('late-1', 'settled', { tx_hash: 'tx-late' });
    assert.equal(updated.state, 'settled');
    assert.equal(
      store.events.has('late-1'),
      false,
      'a terminal event with no Initiated stream must not create a shadow',
    );

    const row = await store.getConsistent('late-1');
    // A partial stream would have lost these fields (projection.js seeds an
    // empty aggregate when a terminal event arrives without Initiated).
    assert.equal(row.state, 'settled');
    assert.equal(row.tx_hash, 'tx-late');
    assert.equal(row.key_id, 'callerC');
    assert.equal(row.network, 'stellar:testnet');
    assert.equal(row.asset, 'USDC');
  });

  test('an in-window update keeps serving this process its own result', async () => {
    const primary = fakePool();
    const replica = fakePool({ lagKeys: ['settle-1'] });
    let clock = 1_000;
    const store = shadowedStore({ primary, replica, clock: () => clock });
    await store.ready;

    await store.save(record('settle-1'));
    clock = 2_000;
    await store.updateState('settle-1', 'settled', { tx_hash: 'tx-settle' });

    const readsBefore = primary.counts.selects + replica.counts.selects;
    const row = await store.getConsistent('settle-1');

    assert.equal(row.state, 'settled');
    assert.equal(row.tx_hash, 'tx-settle');
    assert.equal(primary.counts.selects + replica.counts.selects, readsBefore);
  });

  test('the entry cap evicts least-recently-written streams, not the newest', async () => {
    const primary = fakePool();
    const clock = 1_000;
    const store = shadowedStore({ primary, clock: () => clock, cap: 2 });
    await store.ready;

    await store.save(record('a'));
    await store.save(record('b'));
    // Touch "a" so "b" is the least-recently-written stream.
    await store.updateState('a', 'settled', { tx_hash: 'tx-a' });
    await store.save(record('c'));

    assert.equal(store._shadowWrittenAt.size, 2);
    assert.equal(store.events.size, 2);
    assert.equal(store.events.has('a'), true);
    assert.equal(store.events.has('b'), false, 'the cap evicted the oldest stream');
    assert.equal(store.events.has('c'), true);

    // Eviction is a cache miss, not a data loss: Postgres still has "b".
    const readsBefore = primary.counts.selects;
    const row = await store.getConsistent('b');
    assert.equal(row.idempotency_key, 'b');
    assert.ok(primary.counts.selects > readsBefore);
  });

  test('sustained settlement activity does not grow the shadow without bound', async () => {
    const primary = fakePool();
    let clock = 1_000;
    const cap = 100;
    const store = shadowedStore({ primary, clock: () => clock, cap });
    await store.ready;

    for (let i = 0; i < 1_000; i++) {
      await store.save(record(`stream-${i}`));
      clock += 1_000; // one second between settlements
    }

    // The 60s window retains ~60 entries; the cap is the hard ceiling.
    assert.ok(store.events.size <= cap, `shadow held ${store.events.size} entries with cap ${cap}`);
    assert.equal(store._shadowWrittenAt.size, store.events.size);
    assert.equal(store.events.has('stream-0'), false);
    assert.equal(store.events.has('stream-999'), true);
  });

  test('degraded mode retains local claims instead of pruning them', async () => {
    const primary = fakePool({ rejectWrites: new Error('primary connection terminated') });
    let clock = 1_000;
    const store = shadowedStore({ primary, clock: () => clock, ttl: 1_000 });
    await store.ready;

    await store.save(record('fallback-1'));
    assert.equal(store.degraded, true, 'the failed write latched degraded mode');

    clock = 10_000; // far past the 1s TTL
    await store.save(record('fallback-2'));

    assert.equal(store.events.has('fallback-1'), true);
    assert.equal(store.events.has('fallback-2'), true);
    const row = await store.getConsistent('fallback-1');
    assert.equal(row.state, 'submitted');
    assert.equal(row.key_id, 'callerA');
  });
});
