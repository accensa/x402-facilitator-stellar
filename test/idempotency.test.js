import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryIdempotencyStore, PostgresIdempotencyStore } from '../src/idempotency.js';
import { serve, testConfig, stubFacilitator, stubCatalog, VALID_BODY } from './helpers/app.js';

const RESPONSE = { success: true, transaction: 'abc123', network: 'stellar:testnet' };

test('memory store: first claim owns, duplicate replays, failed claim retries', async () => {
  const store = new MemoryIdempotencyStore();

  const first = await store.begin('retry-1');
  assert.equal(first.replayed, false);

  await store.complete('retry-1', 200, RESPONSE);

  const dup = await store.begin('retry-1');
  assert.equal(dup.replayed, true);
  assert.equal(dup.statusCode, 200);
  assert.deepEqual(dup.response, RESPONSE);

  // A claim still in flight is a conflict, not a second settlement (#408).
  await store.begin('retry-2');
  const conflict = await store.begin('retry-2');
  assert.equal(conflict.conflict, true);

  // A pre-submission failure releases the claim so the retry can proceed.
  await store.fail('retry-2');
  const retry = await store.begin('retry-2');
  assert.equal(retry.replayed, false);
});

test('keyFor: prefers the Idempotency-Key header, falls back to the body hash', () => {
  const store = new MemoryIdempotencyStore();
  const withHeader = { get: () => '  abc  ', body: { x: 1 } };
  assert.equal(store.keyFor(withHeader), 'abc');

  const noHeader = { get: () => undefined, body: { x: 1 } };
  const again = { get: () => undefined, body: { x: 1 } };
  assert.equal(store.keyFor(noHeader), store.keyFor(again));
});

test('/settle replays the recorded response instead of settling twice', async () => {
  const facilitator = stubFacilitator();
  const store = new MemoryIdempotencyStore();
  const instance = await serve({
    config: testConfig(),
    facilitator,
    catalog: stubCatalog(),
    idempotency: store,
  });
  try {
    const headers = { 'idempotency-key': 'same-key' };
    const first = await instance.post('/settle', VALID_BODY, headers);
    const second = await instance.post('/settle', VALID_BODY, headers);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(facilitator.calls.filter(c => c.name === 'settle').length, 1);
  } finally {
    await instance.close();
  }
});

test('/settle without a header keys on the body, deduplicating identical retries', async () => {
  const facilitator = stubFacilitator();
  const store = new MemoryIdempotencyStore();
  const instance = await serve({
    config: testConfig(),
    facilitator,
    catalog: stubCatalog(),
    idempotency: store,
  });
  try {
    await instance.post('/settle', VALID_BODY);
    const second = await instance.post('/settle', VALID_BODY);
    assert.equal(second.status, 200);
    assert.equal(facilitator.calls.filter(c => c.name === 'settle').length, 1);
  } finally {
    await instance.close();
  }
});

/**
 * Minimal pg Pool stand-in: enough SQL to walk the claim path, including the
 * unique-constraint conflict when a second instance claims the same key.
 */
function fakePool() {
  const rows = new Map(); // key -> { status_code, response }
  return {
    rows,
    async connect() {
      return {
        query: async (sql, params) => {
          if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
          if (/INSERT/.test(sql)) {
            if (rows.has(params[0])) return { rowCount: 0 }; // unique conflict
            rows.set(params[0], { status_code: null, response: null });
            return { rowCount: 1 };
          }
          if (/SELECT/.test(sql)) {
            const row = rows.get(params[0]);
            return { rows: row && row.response !== null ? [row] : [] };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
        release: () => {},
      };
    },
    query: async (sql, params) => {
      if (/DELETE/.test(sql)) {
        const row = rows.get(params[0]);
        if (!row || row.response !== null) return { rowCount: 0 };
        rows.delete(params[0]);
        return { rowCount: 1 };
      }
      if (/UPDATE/.test(sql)) {
        rows.get(params[0]).status_code = params[1];
        rows.get(params[0]).response = params[2];
        return { rowCount: 1 };
      }
      if (/SELECT/.test(sql)) {
        const row = rows.get(params[0]);
        return { rows: row && row.response !== null ? [row] : [] };
      }
      throw new Error(`unexpected pool sql: ${sql}`);
    },
  };
}

test('postgres store: serializable claim, replay after complete, conflict resolution', async () => {
  const pool = fakePool();
  const store = new PostgresIdempotencyStore('postgres://unused', {
    pool,
    lockTimeoutMs: 500,
  });

  const first = await store.begin('k1');
  assert.equal(first.replayed, false);
  await store.complete('k1', 200, RESPONSE);

  const replay = await store.begin('k1');
  assert.equal(replay.replayed, true);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.response, RESPONSE);
});

test('postgres store: concurrent claim resolves by polling for the winner response', async () => {
  // Simulates two instances claiming the same retry at once: our INSERT hits
  // the unique constraint (rowCount 0), and the winner records its response
  // moments later, which our poll then finds.
  let polls = 0;
  const RESPONSE2 = { success: true, transaction: 'def456' };
  const store = new PostgresIdempotencyStore('postgres://unused', {
    lockTimeoutMs: 1000,
    pool: {
      async connect() {
        return {
          query: async sql => {
            if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
            if (/INSERT/.test(sql)) return { rowCount: 0 }; // someone else won
            if (/SELECT/.test(sql)) return { rows: [] };
            throw new Error(`unexpected sql: ${sql}`);
          },
          release: () => {},
        };
      },
      query: async sql => {
        if (/SELECT/.test(sql)) {
          polls += 1;
          if (polls >= 2) return { rows: [{ status_code: 200, response: RESPONSE2 }] };
          return { rows: [] };
        }
        throw new Error(`unexpected pool sql: ${sql}`);
      },
    },
  });

  const result = await store.begin('k-race');
  assert.equal(result.replayed, true);
  assert.deepEqual(result.response, RESPONSE2);
});

test('postgres store: an in-flight claim returns a conflict, and fail() releases it', async () => {
  const pool = fakePool();
  const store = new PostgresIdempotencyStore('postgres://unused', {
    pool,
    lockTimeoutMs: 50,
  });

  // Claim without completing: the first instance is still settling.
  const first = await store.begin('k-pending');
  assert.equal(first.replayed, false);

  const duplicate = await store.begin('k-pending');
  assert.equal(duplicate.conflict, true);

  // A pre-submission failure releases the row so a retry may try again.
  await store.fail('k-pending');
  const retry = await store.begin('k-pending');
  assert.equal(retry.replayed, false);
});

test('postgres store: degrades to memory when the database is unreachable', async () => {
  const warnings = [];
  const store = new PostgresIdempotencyStore('postgres://unused', {
    pool: {
      connect: async () => {
        throw new Error('connection refused');
      },
      query: async () => {
        throw new Error('connection refused');
      },
    },
    warn: m => warnings.push(m),
  });

  const result = await store.begin('k-offline');
  assert.equal(result.replayed, false); // fell back, did not throw
  await store.complete('k-offline', 200, RESPONSE);
  const replay = await store.begin('k-offline');
  assert.equal(replay.replayed, true);
});
