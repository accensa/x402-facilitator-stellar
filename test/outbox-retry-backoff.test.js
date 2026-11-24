import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OutboxStore } from '../src/outbox/store.js';

function createMockPool() {
  const rows = new Map();
  let nextId = 1;
  const queries = [];

  return {
    rows,
    queries,
    seed(row) {
      const id = nextId++;
      rows.set(id, {
        id,
        event_id: row.event_id || `evt-${id}`,
        type: row.type || 'test',
        payload: row.payload || {},
        status: row.status || 'pending',
        attempts: row.attempts || 0,
        claimed_at: row.claimed_at || null,
        next_attempt_at: row.next_attempt_at || null,
        created_at: new Date().toISOString(),
      });
      return id;
    },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (
        sql.includes('CREATE TABLE') ||
        sql.includes('ALTER TABLE') ||
        sql.includes('CREATE INDEX')
      ) {
        return { rows: [] };
      }

      if (sql.includes('UPDATE outbox_events SET') && sql.includes('next_attempt_at = CASE')) {
        const [id, lastError, maxAttempts, nowIso, baseBackoffMs, maxBackoffMs] = params;
        const row = rows.get(id);
        if (row) {
          const newAttempts = row.attempts + 1;
          row.attempts = newAttempts;
          row.last_error = lastError;
          row.claimed_at = null;
          if (newAttempts >= maxAttempts) {
            row.status = 'failed';
            row.next_attempt_at = null;
          } else {
            row.status = 'pending';
            const delay = Math.min(
              Number(maxBackoffMs),
              Number(baseBackoffMs) * Math.pow(2, row.attempts - 1),
            );
            row.next_attempt_at = new Date(new Date(nowIso).getTime() + delay).toISOString();
          }
        }
        return { rows: [] };
      }

      if (sql.includes('UPDATE outbox_events SET') && sql.includes("status = 'claimed'")) {
        const [limit, leaseMs] = params;
        const now = Date.now();
        const available = [...rows.values()]
          .filter(r => {
            if (r.status === 'pending') {
              if (!r.next_attempt_at) return true;
              return new Date(r.next_attempt_at).getTime() <= now;
            }
            if (r.status === 'claimed' && r.claimed_at) {
              return now - new Date(r.claimed_at).getTime() > leaseMs;
            }
            return false;
          })
          .slice(0, limit);

        for (const r of available) {
          r.status = 'claimed';
          r.claimed_at = new Date(now).toISOString();
        }
        return { rows: available };
      }

      if (sql.includes('SELECT count(*)::int AS count FROM outbox_events')) {
        const now = Date.now();
        const pendingCount = [...rows.values()].filter(r => {
          if (r.status === 'pending') {
            if (!r.next_attempt_at) return true;
            return new Date(r.next_attempt_at).getTime() <= now;
          }
          return r.status === 'claimed';
        }).length;
        return { rows: [{ count: pendingCount }] };
      }

      return { rows: [] };
    },
  };
}

describe('OutboxStore retry backoff', () => {
  test('markFailed sets exponential backoff on next_attempt_at', async () => {
    const pool = createMockPool();
    const store = new OutboxStore(pool);
    await store.ready;

    const id = pool.seed({ event_id: 'evt-1', attempts: 0 });
    const fixedNow = new Date('2026-11-24T12:00:00.000Z');

    // First failure (attempts -> 1): backoff 1000ms * 2^0 = 1000ms
    await store.markFailed(id, 'timeout 1', 10, {
      baseBackoffMs: 1000,
      now: () => fixedNow,
    });
    let row = pool.rows.get(id);
    assert.equal(row.attempts, 1);
    assert.equal(row.status, 'pending');
    assert.equal(row.next_attempt_at, new Date(fixedNow.getTime() + 1000).toISOString());

    // Second failure (attempts -> 2): backoff 1000ms * 2^1 = 2000ms
    await store.markFailed(id, 'timeout 2', 10, {
      baseBackoffMs: 1000,
      now: () => fixedNow,
    });
    row = pool.rows.get(id);
    assert.equal(row.attempts, 2);
    assert.equal(row.next_attempt_at, new Date(fixedNow.getTime() + 2000).toISOString());

    // Third failure (attempts -> 3): backoff 1000ms * 2^2 = 4000ms
    await store.markFailed(id, 'timeout 3', 10, {
      baseBackoffMs: 1000,
      now: () => fixedNow,
    });
    row = pool.rows.get(id);
    assert.equal(row.attempts, 3);
    assert.equal(row.next_attempt_at, new Date(fixedNow.getTime() + 4000).toISOString());
  });

  test('claimBatch defers rows with next_attempt_at in the future', async () => {
    const pool = createMockPool();
    const store = new OutboxStore(pool);
    await store.ready;

    // One ready row, one deferred row in the future
    const readyId = pool.seed({ event_id: 'ready-1', attempts: 0 });
    const _deferredId = pool.seed({
      event_id: 'deferred-1',
      attempts: 1,
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const claimed = await store.claimBatch({ limit: 10 });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, readyId);

    // countPending considers unexpired claimed rows and pending rows not in future
    // readyId is currently claimed (1), deferredId is pending in future (0)
    const count = await store.countPending();
    assert.equal(count, 1);
  });

  test('exhausted attempts mark row failed with no next_attempt_at', async () => {
    const pool = createMockPool();
    const store = new OutboxStore(pool);
    await store.ready;

    const id = pool.seed({ event_id: 'exhaust-1', attempts: 2 });
    await store.markFailed(id, 'permanent error', 3);

    const row = pool.rows.get(id);
    assert.equal(row.attempts, 3);
    assert.equal(row.status, 'failed');
    assert.equal(row.next_attempt_at, null);
  });
});
