/**
 * Transactional outbox for settlement notifications (#123).
 *
 * What is under test is the guarantee: the event is written in the same
 * transaction as the `settled` state change, the worker publishes it and marks
 * it published only after the publish succeeds, a crash leaves the row pending
 * (re-claimable, re-publishable), and without a durable store the request path
 * falls back to the pre-outbox fire-and-forget publish.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { OutboxStore } from '../src/outbox/store.js';
import { pollOutboxOnce, startOutboxWorker } from '../src/outbox/worker.js';
import { MemorySettlementStore, PostgresSettlementStore } from '../src/store/index.js';
import { reconcileUnknownSettlements } from '../src/store/reconciliation.js';
import { createApp } from '../src/app.js';
import { resolveConfig } from '../src/config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A pg-shaped double with enough real behaviour to exercise the store's SQL:
 * an in-memory settlements map and an outbox row set, dispatching on the
 * statements the code actually emits. Records every statement so tests can
 * assert transaction ordering.
 */
function fakePool() {
  // Event-sourced store (#130): `settlements` here is the read model
  // (settlement_projections), seeded directly and updated by the same CTE
  // the real store issues — an append to settlement_events paired with the
  // projection write derived from it.
  const settlements = new Map();
  const events = [];
  const outbox = new Map(); // id -> row
  let nextId = 1;
  const queries = [];

  const nowIso = () => new Date().toISOString();
  const rowView = r => ({ ...r, created_at: r.created_at, updated_at: r.updated_at });
  const nextSeq = key => {
    const seqs = events.filter(e => e.idempotency_key === key).map(e => e.seq);
    return seqs.length ? Math.max(...seqs) + 1 : 1;
  };

  const pool = {
    settlements,
    events,
    outbox,
    queries,
    /** Direct row access for test setup/assertions. */
    seedSettlement(row) {
      const ts = nowIso();
      settlements.set(row.idempotency_key, {
        idempotency_key: row.idempotency_key,
        network: row.network ?? '',
        scheme: row.scheme ?? '',
        payer: row.payer ?? null,
        pay_to: row.pay_to ?? null,
        asset: row.asset ?? null,
        amount: row.amount ?? null,
        state: row.state ?? 'submitted',
        tx_hash: row.tx_hash ?? null,
        error_reason: row.error_reason ?? null,
        error_message: row.error_message ?? null,
        response: row.response ?? null,
        key_id: row.key_id ?? null,
        created_at: ts,
        updated_at: ts,
      });
    },
    seedOutbox(row) {
      const id = nextId++;
      outbox.set(id, {
        id,
        event_id: row.event_id,
        type: row.type,
        payload: row.payload,
        status: row.status ?? 'pending',
        attempts: row.attempts ?? 0,
        createdAt: Date.now(),
        claimedAtMs: row.claimedAtMs ?? null,
      });
      return id;
    },
    async query(sql, params = []) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: flat, params });
      if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { rows: [] };

      // save(): SettlementInitiated CTE — append event + upsert projection
      if (flat.includes("'SettlementInitiated'")) {
        const [key, payloadJson, network, scheme, payer, payTo, asset, amount, txHash, keyId] =
          params;
        const seq = nextSeq(key);
        const recordedAt = nowIso();
        events.push({
          idempotency_key: key,
          seq,
          event_type: 'SettlementInitiated',
          event_version: 1,
          payload: JSON.parse(payloadJson),
          recorded_at: recordedAt,
        });
        const existing = settlements.get(key);
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
        settlements.set(key, row);
        return { rows: [{ ...row }] };
      }

      // updateState() / settleAndEnqueue(): event-then-projection CTE.
      // settleAndEnqueue passes state 'settled' as $4; updateState passes the
      // requested state — the fake can't tell them apart by SQL, so it applies
      // whatever state the caller requested, exactly like the real store.
      // Must be checked BEFORE the plain SELECT dispatches below: this CTE
      // contains `FROM settlement_projections WHERE idempotency_key = $1`
      // as a substring (inside the EXISTS clause).
      if (
        sql.includes('WHERE settlement_projections.idempotency_key = ins_event.idempotency_key')
      ) {
        const [key, eventType, payloadJson, state, txHash, errorReason, errorMessage, response] =
          params;
        const existing = settlements.get(key);
        if (!existing) return { rows: [] };
        const seq = nextSeq(key);
        const recordedAt = nowIso();
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
        settlements.set(key, row);
        return { rows: [{ ...row }] };
      }

      if (sql.includes('UPDATE outbox_events SET') && sql.includes("status = 'claimed'")) {
        const [limit, leaseMs] = params;
        const now = Date.now();
        const candidates = [...outbox.values()]
          .filter(
            r =>
              r.status === 'pending' ||
              (r.status === 'claimed' && r.claimedAtMs !== null && now - r.claimedAtMs > leaseMs),
          )
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, limit);
        const rows = [];
        for (const r of candidates) {
          r.status = 'claimed';
          r.claimedAtMs = now;
          rows.push(r);
        }
        return {
          rows: rows.map(r => ({
            id: r.id,
            event_id: r.event_id,
            type: r.type,
            payload: r.payload,
            attempts: r.attempts,
            created_at: new Date(r.createdAt).toISOString(),
          })),
        };
      }

      // get(idempotencyKey) — a bare SELECT (not the CTE, which is dispatched
      // above).
      if (
        flat.startsWith('SELECT') &&
        flat.includes('FROM settlement_projections WHERE idempotency_key = $1')
      ) {
        const row = settlements.get(params[0]);
        return { rows: row ? [rowView(row)] : [] };
      }

      // listUnknown()
      if (flat.includes('FROM settlement_projections WHERE state = $1')) {
        const rows = [...settlements.values()].filter(r => r.state === params[0]);
        return { rows: rows.map(rowView) };
      }

      if (sql.includes("status = 'published'")) {
        const [id] = params;
        const r = outbox.get(Number(id));
        if (r) {
          r.status = 'published';
          r.publishedAtMs = Date.now();
          r.claimedAtMs = null;
        }
        return { rows: [] };
      }

      if (sql.includes('attempts = attempts + 1')) {
        const [id, error, maxAttempts] = params;
        const r = outbox.get(Number(id));
        if (r) {
          r.attempts += 1;
          r.lastError = error;
          r.status = r.attempts >= Number(maxAttempts) ? 'failed' : 'pending';
          r.claimedAtMs = null;
        }
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO outbox_events')) {
        const [eventId, type, payload] = params;
        const id = nextId++;
        outbox.set(id, {
          id,
          event_id: eventId,
          type,
          payload: JSON.parse(payload),
          status: 'pending',
          attempts: 0,
          createdAt: Date.now(),
          claimedAtMs: null,
        });
        return { rows: [] };
      }

      if (sql.includes('count(*)')) {
        const count = [...outbox.values()].filter(
          r => r.status === 'pending' || r.status === 'claimed',
        ).length;
        return { rows: [{ count }] };
      }

      throw new Error(`fakePool: unexpected statement ${flat}`);
    },
    async connect() {
      return {
        // Only the transaction control statements are recorded here; data
        // statements delegate to pool.query, which records them.
        async query(sql, params = []) {
          const flat = sql.replace(/\s+/g, ' ').trim();
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(flat)) {
            queries.push({ sql: flat, params });
            return { rows: [] };
          }
          return pool.query(sql, params);
        },
        release() {},
      };
    },
  };
  return pool;
}

describe('OutboxStore (#123)', () => {
  test('claims pending rows and returns them with parsed payloads', async () => {
    const pool = fakePool();
    pool.seedOutbox({
      event_id: 'e1',
      type: 'settlement.completed',
      payload: { transaction: 'tx1' },
    });
    pool.seedOutbox({
      event_id: 'e2',
      type: 'settlement.completed',
      payload: { transaction: 'tx2' },
    });
    const store = new OutboxStore(pool);

    const rows = await store.claimBatch({ limit: 10, leaseMs: 60_000 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event_id, 'e1');
    assert.deepEqual(rows[0].payload, { transaction: 'tx1' });
    assert.equal(await store.countPending(), 2, 'claimed rows count as in-flight, not lost');
  });

  test('a fresh claim is not stolen; an expired claim is re-claimed', async () => {
    const pool = fakePool();
    pool.seedOutbox({ event_id: 'fresh', status: 'claimed', claimedAtMs: Date.now() });
    pool.seedOutbox({ event_id: 'stale', status: 'claimed', claimedAtMs: 0 });
    const store = new OutboxStore(pool);

    const rows = await store.claimBatch({ limit: 10, leaseMs: 60_000 });
    assert.deepEqual(
      rows.map(r => r.event_id),
      ['stale'],
      'only the expired lease is re-claimed',
    );
  });

  test('markPublished flips the row to published; markFailed retries then gives up', async () => {
    const pool = fakePool();
    pool.seedOutbox({ event_id: 'ok' });
    pool.seedOutbox({ event_id: 'bad' });
    const store = new OutboxStore(pool);

    const rows = await store.claimBatch({ limit: 10, leaseMs: 60_000 });
    const ok = rows.find(r => r.event_id === 'ok');
    const bad = rows.find(r => r.event_id === 'bad');
    await store.markPublished(ok.id);
    assert.equal(pool.outbox.get(ok.id).status, 'published');

    await store.markFailed(bad.id, 'broker unreachable', 3);
    assert.equal(pool.outbox.get(bad.id).status, 'pending');
    assert.equal(pool.outbox.get(bad.id).attempts, 1);
    await store.markFailed(bad.id, 'broker unreachable', 3);
    await store.markFailed(bad.id, 'broker unreachable', 3);
    assert.equal(pool.outbox.get(bad.id).status, 'failed', 'maxAttempts reached -> failed');
    assert.equal(pool.outbox.get(bad.id).attempts, 3);
  });
});

describe('outbox worker (#123)', () => {
  test('publishes claimed events and marks them published', async () => {
    const pool = fakePool();
    pool.seedOutbox({
      event_id: 'e1',
      type: 'settlement.completed',
      payload: { transaction: 'tx1' },
    });
    pool.seedOutbox({
      event_id: 'e2',
      type: 'settlement.completed',
      payload: { transaction: 'tx2' },
    });
    const store = new OutboxStore(pool);
    const published = [];
    const fixedNow = new Date('2026-08-26T12:00:00Z');

    const result = await pollOutboxOnce({
      outbox: store,
      publish: async record => published.push(record),
      now: () => fixedNow,
    });

    assert.equal(result.published, 2);
    assert.equal(published.length, 2);
    // The published record keeps the pre-outbox wire shape: {id, ...event, publishedAt}.
    assert.equal(published[0].id, 'e1');
    assert.equal(published[0].transaction, 'tx1');
    assert.equal(published[0].publishedAt, fixedNow.toISOString());
    assert.equal(await store.countPending(), 0, 'published rows are no longer pending');
  });

  test('a failed publish leaves the event pending for the next cycle', async () => {
    const pool = fakePool();
    pool.seedOutbox({ event_id: 'e1', payload: { transaction: 'tx1' } });
    const store = new OutboxStore(pool);
    let failFirst = true;
    const published = [];

    const first = await pollOutboxOnce({
      outbox: store,
      publish: async record => {
        if (failFirst) {
          failFirst = false;
          throw new Error('broker unreachable');
        }
        published.push(record);
      },
    });
    assert.equal(first.failed, 1);
    assert.equal(await store.countPending(), 1, 'failed event stays pending');

    const second = await pollOutboxOnce({
      outbox: store,
      publish: async record => published.push(record),
    });
    assert.equal(second.published, 1);
    assert.equal(published[0].id, 'e1', 'the same event is retried, not dropped');
  });

  test('start/stop worker: tick runs one cycle, stop clears the timer', async () => {
    const pool = fakePool();
    pool.seedOutbox({ event_id: 'e1', payload: { x: 1 } });
    const store = new OutboxStore(pool);
    const published = [];
    const worker = startOutboxWorker({
      outbox: store,
      intervalMs: 10_000,
      publish: async record => published.push(record),
    });
    worker.start();
    await worker.tick();
    await sleep(5);
    await worker.stop();
    assert.equal(published.length, 1);
    assert.equal(await store.countPending(), 0);
  });
});

describe('settleAndEnqueue — same transaction as the state change (#123)', () => {
  test('MemorySettlementStore reports atomicallyEnqueued false (caller falls back)', async () => {
    const store = new MemorySettlementStore();
    await store.save({ idempotency_key: 'k1', network: 'n', scheme: 's', state: 'submitted' });
    const event = { type: 'settlement.completed', transaction: 'tx1' };

    const outcome = await store.settleAndEnqueue('k1', { tx_hash: 'tx1' }, event);
    assert.equal(outcome.atomicallyEnqueued, false);
    assert.equal(outcome.event, event);
    assert.equal((await store.get('k1')).state, 'settled');
  });

  test('PostgresSettlementStore updates state and inserts the event in one transaction', async () => {
    const pool = fakePool();
    pool.seedSettlement({ idempotency_key: 'k1', network: 'stellar:testnet', scheme: 'exact' });
    const store = new PostgresSettlementStore('postgres://fake', { pool });
    const event = {
      type: 'settlement.completed',
      transaction: 'tx_abc',
      network: 'stellar:testnet',
    };

    const outcome = await store.settleAndEnqueue('k1', { tx_hash: 'tx_abc' }, event);

    assert.equal(outcome.atomicallyEnqueued, true);
    assert.equal(pool.settlements.get('k1').state, 'settled');
    assert.equal(await store.outbox.countPending(), 1);
    const row = [...pool.outbox.values()][0];
    assert.equal(row.event_id, outcome.event.id);
    assert.equal(row.payload.transaction, 'tx_abc');
    assert.equal(row.status, 'pending');

    // The three statements must share one transaction boundary.
    const flat = pool.queries.map(q => q.sql);
    const begin = flat.indexOf('BEGIN');
    const commit = flat.indexOf('COMMIT');
    const update = flat.findIndex(s =>
      s.includes('WHERE settlement_projections.idempotency_key = ins_event.idempotency_key'),
    );
    const insert = flat.findIndex(s => s.includes('INSERT INTO outbox_events'));
    assert.ok(
      begin < update && update < insert && insert < commit,
      'state change + outbox insert commit atomically',
    );
  });

  test('a failing transaction rolls back and falls back to the non-atomic path', async () => {
    const pool = fakePool();
    const store = new PostgresSettlementStore('postgres://fake', { pool });
    // save() mirrors the settle flow: it writes both the pool and the
    // in-memory mirror, so the degraded fallback has something to update.
    await store.save({ idempotency_key: 'k1', network: 'n', scheme: 's', state: 'submitted' });
    // Sabotage the UPDATE after the pool was built (store keeps its own refs).
    const originalQuery = pool.query.bind(pool);
    let failNext = true;
    pool.query = async (sql, params) => {
      if (
        failNext &&
        sql.includes('WHERE settlement_projections.idempotency_key = ins_event.idempotency_key')
      ) {
        failNext = false;
        throw new Error('connection lost');
      }
      return originalQuery(sql, params);
    };

    const warns = [];
    store.warn = m => warns.push(m);
    const outcome = await store.settleAndEnqueue('k1', { tx_hash: 'tx1' }, { type: 't' });

    assert.equal(outcome.atomicallyEnqueued, false, 'degraded to the non-atomic path');
    assert.equal((await store.get('k1')).state, 'settled', 'memory fallback still settles');
    assert.ok(warns.some(w => w.includes('settleAndEnqueue failed')));
  });

  test('no event -> state change only, no outbox row', async () => {
    const pool = fakePool();
    pool.seedSettlement({ idempotency_key: 'k1', network: 'n', scheme: 's' });
    const store = new PostgresSettlementStore('postgres://fake', { pool });

    const outcome = await store.settleAndEnqueue('k1', { tx_hash: 'tx1' }, null);
    assert.equal(outcome.atomicallyEnqueued, true);
    assert.equal(outcome.event, null);
    assert.equal(await store.outbox.countPending(), 0);
  });
});

describe('app settle path with the outbox (#123)', () => {
  function makeConfig() {
    return resolveConfig({
      FACILITATOR_SECRET: Keypair.random().secret(),
      FACILITATOR_API_KEYS: 'k:sec123',
    });
  }

  const facilitator = () => ({
    settle: async () => ({
      success: true,
      transaction: 'tx_hash_1',
      network: 'stellar:testnet',
      payer: 'G_PAYER',
    }),
    getSupported: () => ({}),
  });
  const rateLimiter = () => ({
    checkSettle: async () => ({ allowed: true }),
    recordSettle: async () => {},
  });
  const payload = {
    paymentPayload: { transaction: 'TX_XDR_1' },
    paymentRequirements: { network: 'stellar:testnet', scheme: 'exact-stellar', payTo: 'G_PAYEE' },
  };

  test('memory store falls back to the fire-and-forget enqueue', async () => {
    const store = new MemorySettlementStore();
    const enqueued = [];
    const app = createApp(makeConfig(), facilitator(), rateLimiter(), {}, null, {
      settlementStore: store,
      webhooks: { enqueue: e => enqueued.push(e) },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/settle',
        headers: { authorization: 'Bearer sec123' },
        payload,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(enqueued.length, 1, 'memory mode publishes via the fallback');
      assert.equal(enqueued[0].type, 'settlement.completed');
      assert.equal(enqueued[0].transaction, 'tx_hash_1');
    } finally {
      await app.close();
    }
  });

  test('postgres store writes the outbox row and never calls the fallback enqueue', async () => {
    const pool = fakePool();
    const store = new PostgresSettlementStore('postgres://fake', { pool });
    const enqueued = [];
    const app = createApp(makeConfig(), facilitator(), rateLimiter(), {}, null, {
      settlementStore: store,
      webhooks: { enqueue: e => enqueued.push(e) },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/settle',
        headers: { authorization: 'Bearer sec123' },
        payload,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(enqueued.length, 0, 'the outbox owns the notification now');
      assert.equal(
        await store.outbox.countPending(),
        1,
        'event persisted atomically with the state change',
      );
      const row = [...pool.outbox.values()][0];
      assert.equal(row.payload.transaction, 'tx_hash_1');
    } finally {
      await app.close();
    }
  });
});

describe('reconciliation notifies through the outbox (#123)', () => {
  test('resolving unknown -> settled enqueues a settlement.completed event atomically', async () => {
    const pool = fakePool();
    pool.seedSettlement({
      idempotency_key: 'unresolved-1',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      payer: 'G_PAYER',
      pay_to: 'G_PAYEE',
      amount: '10000',
      asset: 'USDC',
      state: 'unknown',
      tx_hash: 'tx_confirmed_123',
    });
    const store = new PostgresSettlementStore('postgres://fake', { pool });
    const mockRpc = async () => ({ result: { status: 'SUCCESS' } });

    const res = await reconcileUnknownSettlements(
      store,
      { perNetwork: { 'stellar:testnet': { rpcUrl: 'https://rpc' } } },
      { rpcCall: mockRpc },
    );

    assert.equal(res.reconciled, 1);
    assert.equal(pool.settlements.get('unresolved-1').state, 'settled');
    assert.equal(await store.outbox.countPending(), 1);
    const row = [...pool.outbox.values()][0];
    assert.equal(row.type, 'settlement.completed');
    assert.equal(row.payload.transaction, 'tx_confirmed_123');
    assert.equal(row.payload.payTo, 'G_PAYEE');
  });

  test('memory store reconciliation stays a no-op for notifications (unchanged behaviour)', async () => {
    const store = new MemorySettlementStore();
    await store.save({
      idempotency_key: 'unresolved-2',
      network: 'stellar:testnet',
      scheme: 'exact-stellar',
      tx_hash: 'tx_confirmed_456',
    });
    // Event-sourced store (#130): 'unknown' is a state the projection derives
    // from an appended event, not a field on save().
    await store.updateState('unresolved-2', 'unknown', {
      error_reason: 'submitted_outcome_unknown',
    });
    const mockRpc = async () => ({ result: { status: 'SUCCESS' } });

    const res = await reconcileUnknownSettlements(
      store,
      { perNetwork: { 'stellar:testnet': { rpcUrl: 'https://rpc' } } },
      { rpcCall: mockRpc },
    );
    assert.equal(res.reconciled, 1);
    assert.equal((await store.get('unresolved-2')).state, 'settled');
  });
});
