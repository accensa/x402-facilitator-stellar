import test from 'node:test';
import assert from 'node:assert/strict';
import { CrdtRateLimitStore } from '../src/crdt-rate-limit-store.js';

function recoveringPool() {
  const data = new Map();
  return {
    data,
    fail: false,
    async query(sql, params) {
      if (this.fail) throw new Error('connection refused');
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return {};
      if (/INSERT.*ON CONFLICT.*DO UPDATE/s.test(sql)) {
        const [bucketId, count, resetAt, region] = params;
        const existing = data.get(bucketId);
        const mergedCount = existing ? Math.max(existing.count, count) : count;
        data.set(bucketId, { count: mergedCount, reset_at: resetAt, region });
        return { rows: [{ count: mergedCount }] };
      }
      if (/SELECT 1 FROM crdt_rate_limit_buckets LIMIT 0/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    async end() {},
    on() {},
  };
}

test('a later successful sync recovers after a transient database failure', async () => {
  const pool = recoveringPool();
  const warnings = [];
  const store = new CrdtRateLimitStore({
    region: 'us-east-1',
    pool,
    syncIntervalMs: 60_000,
    warn: message => warnings.push(message),
  });

  const now = Math.floor(Date.now() / 1000);
  await store.increment('key', 5, now + 60, now);
  pool.fail = true;
  await store._sync();
  assert.equal(store.degraded, true);

  pool.fail = false;
  await store._sync();

  assert.equal(store.degraded, false);
  assert.equal(pool.data.get('key').count, 5);
  assert.ok(warnings.some(message => message.includes('database reconnected')));
  await store.close();
});

test('an empty degraded store probes the database before recovering', async () => {
  const pool = recoveringPool();
  const store = new CrdtRateLimitStore({
    region: 'us-east-1',
    pool,
    syncIntervalMs: 60_000,
    warn: () => {},
  });

  store._degrade('test outage');
  pool.fail = true;
  await store._sync();
  assert.equal(store.degraded, true);

  pool.fail = false;
  await store._sync();
  assert.equal(store.degraded, false);
  await store.close();
});
