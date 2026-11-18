/**
 * Degradation must be reversible (#729).
 *
 * A single transient Postgres failure used to flip `degraded` to true forever:
 * begin() then answered { replayed: false } from process-local memory for the
 * rest of the process's life, so two replicas could settle the same key at the
 * same time with no cross-replica dedupe. These tests pin the recovery path —
 * the probe restores the durable store, and claims recorded during the outage
 * are written back before the store calls itself healthy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresIdempotencyStore } from '../src/idempotency.js';

const RESPONSE = { success: true, transaction: 'abc123', network: 'stellar:testnet' };

/**
 * A configurable pg Pool stand-in. `state.healthy` flips the whole pool between
 * "connection refused" and a working in-memory idempotency_keys table, so a
 * test can simulate one outage and a recovery.
 */
function fakePool() {
  const rows = new Map(); // key -> { status_code, response }
  const state = { healthy: true, connectAttempts: 0, queries: [] };

  const run = async (sql, params = []) => {
    state.queries.push(sql);
    if (!state.healthy) throw new Error('connection refused');

    if (/^\s*SELECT 1\s*$/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};

    if (/INSERT/.test(sql)) {
      // Backfill from the memory fallback writes a completed row directly.
      // A completed row wins over a pending one but never overwrites another
      // replica's recorded response.
      if (/status_code/.test(sql)) {
        const [key, statusCode, response] = params;
        const existing = rows.get(key);
        if (existing && existing.response !== null) return { rowCount: 0 };
        rows.set(key, { status_code: statusCode, response });
        return { rowCount: 1 };
      }
      if (rows.has(params[0])) return { rowCount: 0 };
      rows.set(params[0], { status_code: null, response: null });
      return { rowCount: 1 };
    }

    if (/SELECT/.test(sql)) {
      const row = rows.get(params[0]);
      return { rows: row && row.response !== null ? [row] : [] };
    }

    if (/UPDATE/.test(sql)) {
      const row = rows.get(params[0]);
      if (!row) return { rowCount: 0 };
      row.status_code = params[1];
      row.response = params[2];
      return { rowCount: 1 };
    }

    if (/DELETE/.test(sql)) {
      const row = rows.get(params[0]);
      if (!row || row.response !== null) return { rowCount: 0 };
      rows.delete(params[0]);
      return { rowCount: 1 };
    }

    throw new Error(`unexpected sql: ${sql}`);
  };

  return {
    state,
    rows,
    async connect() {
      state.connectAttempts += 1;
      if (!state.healthy) throw new Error('connection refused');
      return { query: run, release: () => {} };
    },
    query: run,
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`condition did not become true within ${timeoutMs}ms`);
}

test('a transient query failure degrades, and recovery resumes durable claims', async () => {
  const pool = fakePool();
  const warnings = [];
  const store = new PostgresIdempotencyStore('postgres://unused', {
    pool,
    warn: message => warnings.push(message),
    lockTimeoutMs: 50,
    // Keep the background timer out of this test; recovery is driven explicitly.
    recoveryIntervalMs: 60_000,
  });

  // The database is down for exactly the first claim.
  pool.state.healthy = false;
  const duringOutage = await store.begin('outage-key');
  assert.equal(duringOutage.replayed, false);
  assert.equal(store.degraded, true);
  assert.match(warnings[0], /process-local only/);

  // A settlement completed while degraded lives only in memory.
  await store.complete('outage-key', 200, RESPONSE);
  assert.equal(pool.rows.size, 0);

  // A failed COMMIT can leave a pending row behind; recovery completes it
  // rather than leaving the key stuck as an in-flight conflict forever.
  pool.rows.set('outage-key', { status_code: null, response: null });

  // Postgres comes back; the probe must restore the durable path.
  pool.state.healthy = true;
  assert.equal(await store._recover(), true);
  assert.equal(store.degraded, false);
  assert.match(warnings.at(-1), /durable idempotency resumed/);

  // The completed response is now durable, not lost with the memory fallback.
  assert.equal(pool.rows.get('outage-key').status_code, 200);
  assert.deepEqual(JSON.parse(pool.rows.get('outage-key').response), RESPONSE);

  // And begin() goes back to Postgres, so another replica sees the replay.
  const queriesBefore = pool.state.queries.length;
  const replay = await store.begin('outage-key');
  assert.equal(replay.replayed, true);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.response, RESPONSE);
  assert.ok(
    pool.state.queries.length > queriesBefore,
    'begin() must query Postgres again after recovery',
  );
});

test('a background probe restores the durable path without a request', async () => {
  const pool = fakePool();
  const warnings = [];
  const store = new PostgresIdempotencyStore('postgres://unused', {
    pool,
    warn: message => warnings.push(message),
    lockTimeoutMs: 50,
    recoveryIntervalMs: 10,
  });

  pool.state.healthy = false;
  await store.begin('outage-key');
  assert.equal(store.degraded, true);

  pool.state.healthy = true;
  await waitFor(() => store.degraded === false);

  assert.match(warnings.at(-1), /durable idempotency resumed/);
  assert.ok(pool.state.queries.includes('SELECT 1'), 'recovery must probe the connection');
});

test('begin() probes after the interval and resumes automatically', async () => {
  const pool = fakePool();
  const warnings = [];
  const store = new PostgresIdempotencyStore('postgres://unused', {
    pool,
    warn: message => warnings.push(message),
    lockTimeoutMs: 50,
    // 0 makes the next begin() the probe trigger, with no background timer.
    recoveryIntervalMs: 0,
  });

  pool.state.healthy = false;
  await store.begin('outage-key');
  assert.equal(store.degraded, true);

  pool.state.healthy = true;
  const queriesBefore = pool.state.queries.length;
  const claim = await store.begin('recovered-key');
  assert.equal(claim.replayed, false);
  assert.equal(store.degraded, false);
  assert.ok(pool.state.queries.length > queriesBefore);
  assert.ok(pool.rows.has('recovered-key'), 'the claim must be durable again');
  assert.match(warnings.at(-1), /durable idempotency resumed/);
});
