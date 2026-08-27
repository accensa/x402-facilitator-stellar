/**
 * CRDT G-Counter rate limit store (#126).
 *
 * Validates the CRDT merge semantics, local-only degradation, periodic sync,
 * and convergence behaviour. No external services — uses a fake pg Pool.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CrdtRateLimitStore } from '../src/crdt-rate-limit-store.js';

/**
 * Fake pg Pool — enough for the CRDT store's UPSERT + SELECT queries.
 *
 * Maintains an in-memory table that mirrors the real schema. Supports
 * injecting failures to test degradation.
 */
function fakePool({ fail = false, data = new Map() } = {}) {
  return {
    data,
    async query(sql, params) {
      if (fail) throw new Error('connection refused');

      // CREATE TABLE / INDEX — no-ops.
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return {};

      // UPSERT with GREATEST merge.
      if (/INSERT.*ON CONFLICT.*DO UPDATE/s.test(sql)) {
        const [bucketId, count, resetAt, region] = params;
        const existing = data.get(bucketId);
        if (existing && existing.reset_at > resetAt) {
          // Existing row has a later window — skip the upsert.
          return { rows: [] };
        }
        if (existing) {
          // New window (existing.reset_at < resetAt): replace, don't merge.
          // Same window: GREATEST merge.
          existing.count = existing.reset_at < resetAt ? count : Math.max(existing.count, count);
          existing.reset_at = resetAt;
          existing.region = region;
        } else {
          data.set(bucketId, {
            count,
            reset_at: resetAt,
            region,
          });
        }
        return { rows: [{ count: data.get(bucketId).count }] };
      }

      // SELECT.
      if (/SELECT/.test(sql)) {
        const bucketId = params?.[0];
        const row = data.get(bucketId);
        if (row) return { rows: [{ count: row.count, reset_at: row.reset_at }] };
        return { rows: [] };
      }

      // DELETE (sweep).
      if (/DELETE/.test(sql)) {
        const threshold = params?.[0];
        for (const [key, row] of data) {
          if (row.reset_at <= threshold) data.delete(key);
        }
        return {};
      }

      return {};
    },
    async end() {},
    on() {},
  };
}

const now = () => Math.floor(Date.now() / 1000);

describe('CrdtRateLimitStore', () => {
  afterEach(() => {});

  test('basic increment and get within a window', async () => {
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool: fakePool(),
      syncIntervalMs: 60_000, // long — don't auto-sync during test
    });

    const t = now();
    const result = await store.increment('owner:verify:window:60', 1, t + 60, t);
    assert.equal(result.count, 1);

    const got = await store.get('owner:verify:window:60', t);
    assert.equal(got.count, 1);
    assert.equal(got.resetAt, t + 60);

    await store.close();
  });

  test('multiple increments accumulate within a window', async () => {
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool: fakePool(),
      syncIntervalMs: 60_000,
    });

    const t = now();
    await store.increment('key', 1, t + 60, t);
    await store.increment('key', 1, t + 60, t);
    await store.increment('key', 1, t + 60, t);

    const got = await store.get('key', t);
    assert.equal(got.count, 3);

    await store.close();
  });

  test('new window starts fresh when expired', async () => {
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool: fakePool(),
      syncIntervalMs: 60_000,
    });

    const t = now();
    await store.increment('key', 5, t - 1, t); // expired window
    const got = await store.get('key', t);
    assert.equal(got.count, 5);

    // Increment with current window.
    const t2 = t + 1;
    await store.increment('key', 2, t + 60, t2);
    const got2 = await store.get('key', t2);
    assert.equal(got2.count, 2);

    await store.close();
  });

  test('CRDT merge: local count dominates when ahead of remote', async () => {
    const pool = fakePool();
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool,
      syncIntervalMs: 60_000,
    });

    const t = now();
    // Simulate a remote write with a lower count.
    pool.data.set('key', { count: 2, reset_at: t + 60, region: 'eu-west-1' });

    // Local increment brings count to 5.
    await store.increment('key', 5, t + 60, t);

    // The merged read should be max(5, 2) = 5.
    const got = await store.get('key', t);
    assert.equal(got.count, 5);

    await store.close();
  });

  test('CRDT merge: remote count dominates when ahead of local', async () => {
    const pool = fakePool();
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool,
      syncIntervalMs: 60_000,
    });

    const t = now();
    // Simulate a remote write with a higher count.
    pool.data.set('key', { count: 10, reset_at: t + 60, region: 'eu-west-1' });

    // Local increment brings count to 2 (fresh start from expired window).
    await store.increment('key', 1, t + 60, t);

    // The merged read should be max(2, 10) = 10.
    const got = await store.get('key', t);
    assert.equal(got.count, 10);

    await store.close();
  });

  test('degrades to local-only mode when pool fails', async () => {
    const warnings = [];
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool: fakePool({ fail: true }),
      syncIntervalMs: 60_000,
      warn: m => warnings.push(m),
    });

    const t = now();
    await store.increment('key', 3, t + 60, t);
    assert.equal(store.degraded, true);

    const got = await store.get('key', t);
    assert.equal(got.count, 3);
    assert.ok(warnings.some(m => m.includes('local-only')));

    await store.close();
  });

  test('sweep removes expired buckets', async () => {
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool: fakePool(),
      syncIntervalMs: 60_000,
    });

    const t = now();
    await store.increment('expired', 1, t - 10, t);
    await store.increment('active', 1, t + 60, t);

    await store.sweep(t);
    const expired = await store.get('expired', t);
    const active = await store.get('active', t);

    assert.equal(expired, undefined);
    assert.equal(active.count, 1);

    await store.close();
  });

  test('concurrent increments from same region are atomic', async () => {
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool: fakePool(),
      syncIntervalMs: 60_000,
    });

    const t = now();
    await Promise.all(Array.from({ length: 100 }, () => store.increment('counter', 1, t + 60, t)));

    const got = await store.get('counter', t);
    // In-memory Map is single-threaded within one process, so all 100
    // increments should be accounted for.
    assert.equal(got.count, 100);

    await store.close();
  });

  test('sync writes merged counts to the database', async () => {
    const pool = fakePool();
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool,
      syncIntervalMs: 60_000,
    });

    const t = now();
    await store.increment('key', 5, t + 60, t);

    // Trigger sync.
    await store._sync();

    // Verify the database has the local count.
    const dbRow = pool.data.get('key');
    assert.equal(dbRow.count, 5);
    assert.equal(dbRow.region, 'us-east-1');

    await store.close();
  });

  test('sync merges with existing remote data using GREATEST', async () => {
    const pool = fakePool();
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool,
      syncIntervalMs: 60_000,
    });

    // Pre-populate with a remote value.
    pool.data.set('key', { count: 10, reset_at: now() + 60, region: 'eu-west-1' });

    const t = now();
    await store.increment('key', 3, t + 60, t);

    // Trigger sync.
    await store._sync();

    // The database should have max(3, 10) = 10.
    const dbRow = pool.data.get('key');
    assert.equal(dbRow.count, 10);

    await store.close();
  });

  test('close stops the sync timer', async () => {
    const pool = fakePool();
    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool,
      syncIntervalMs: 10,
    });

    // Wait for the table init and start.
    await new Promise(r => setTimeout(r, 20));

    await store.close();
    assert.equal(store._closed, true);
    assert.equal(store._syncTimer, null);
  });
});

describe('multi-region convergence', () => {
  test('two regions incrementing independently converge after sync', async () => {
    const sharedPool = fakePool();

    const regionA = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool: sharedPool,
      syncIntervalMs: 60_000,
    });

    const regionB = new CrdtRateLimitStore({
      region: 'eu-west-1',
      pool: sharedPool,
      syncIntervalMs: 60_000,
    });

    const t = now();
    // Region A increments 3 times.
    await regionA.increment('shared-key', 1, t + 60, t);
    await regionA.increment('shared-key', 1, t + 60, t);
    await regionA.increment('shared-key', 1, t + 60, t);

    // Region B increments 2 times.
    await regionB.increment('shared-key', 1, t + 60, t);
    await regionB.increment('shared-key', 1, t + 60, t);

    // Both regions see their own count first.
    const localA = await regionA.get('shared-key', t);
    const localB = await regionB.get('shared-key', t);
    assert.equal(localA.count, 3);
    assert.equal(localB.count, 2);

    // After both sync, the database has max(3, 2) = 3.
    await regionA._sync();
    await regionB._sync();

    // Both regions now see the merged count.
    const mergedA = await regionA.get('shared-key', t);
    const mergedB = await regionB.get('shared-key', t);
    assert.equal(mergedA.count, 3);
    assert.equal(mergedB.count, 3);

    await regionA.close();
    await regionB.close();
  });

  test('region continues operating during database outage', async () => {
    let dbDown = false;
    const pool = {
      async query(sql) {
        if (dbDown) throw new Error('connection refused');
        if (/CREATE/.test(sql)) return {};
        if (/INSERT.*ON CONFLICT/.test(sql)) return { rows: [{ count: 0 }] };
        if (/SELECT/.test(sql)) return { rows: [] };
        if (/DELETE/.test(sql)) return {};
        return {};
      },
      async end() {},
      on() {},
    };

    const store = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool,
      syncIntervalMs: 60_000,
    });

    const t = now();
    await store.increment('key', 1, t + 60, t);
    assert.equal(store.degraded, false);

    // Database goes down.
    dbDown = true;

    // Service keeps operating.
    await store.increment('key', 1, t + 60, t + 1);
    const got = await store.get('key', t + 1);
    assert.equal(got.count, 2);
    assert.equal(store.degraded, true);

    await store.close();
  });

  test('G-Counter merge never decreases the count', async () => {
    const sharedPool = fakePool();

    const regionA = new CrdtRateLimitStore({
      region: 'us-east-1',
      pool: sharedPool,
      syncIntervalMs: 60_000,
    });

    const regionB = new CrdtRateLimitStore({
      region: 'eu-west-1',
      pool: sharedPool,
      syncIntervalMs: 60_000,
    });

    const t = now();
    // Region A increments to 5.
    for (let i = 0; i < 5; i++) {
      await regionA.increment('key', 1, t + 60, t);
    }

    // Region B increments to 2.
    for (let i = 0; i < 2; i++) {
      await regionB.increment('key', 1, t + 60, t);
    }

    // Sync A first — database gets 5.
    await regionA._sync();

    // Sync B — database gets max(2, 5) = 5.
    await regionB._sync();

    // A reads — should be max(5, 5) = 5.
    const readA = await regionA.get('key', t);
    assert.equal(readA.count, 5);

    // B reads — should be max(2, 5) = 5.
    const readB = await regionB.get('key', t);
    assert.equal(readB.count, 5);

    await regionA.close();
    await regionB.close();
  });
});
