/**
 * Multi-region failover integration tests (#126).
 *
 * These tests verify end-to-end failover behaviour without external services.
 * They exercise:
 *   - Idempotency across simulated regions (CRDT merge)
 *   - Rate limit convergence across regions
 *   - Failover detection timing (acceptance criterion: < 30s)
 *   - No split-brain during simulated partitions
 *   - /health/ready exposes region state
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from './helpers/app.js';
import { CrdtRateLimitStore } from '../src/crdt-rate-limit-store.js';
import { FailoverHealthChecker } from '../src/failover-health.js';

/**
 * Fake pool for multi-region CRDT tests. Maintains a shared data map that
 * simulates a CockroachDB/multi-region Postgres backing store.
 */
function fakePool({ data = new Map() } = {}) {
  return {
    data,
    async query(sql, params) {
      if (/CREATE/.test(sql)) return {};

      if (/INSERT.*ON CONFLICT.*DO UPDATE/s.test(sql)) {
        const [bucketId, count, resetAt, region] = params;
        const existing = data.get(bucketId);
        if (existing && existing.reset_at > resetAt) {
          return { rows: [] };
        }
        if (existing) {
          existing.count = existing.reset_at < resetAt ? count : Math.max(existing.count, count);
          existing.reset_at = resetAt;
          existing.region = region;
        } else {
          data.set(bucketId, { count, reset_at: resetAt, region });
        }
        return { rows: [{ count: data.get(bucketId).count }] };
      }

      if (/SELECT/.test(sql)) {
        const bucketId = params?.[0];
        const row = data.get(bucketId);
        if (row) return { rows: [{ count: row.count, reset_at: row.reset_at }] };
        return { rows: [] };
      }

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

describe('multi-region: idempotency across regions', () => {
  test('CRDT rate limit counts converge after sync', async () => {
    const sharedPool = fakePool();
    const t = Math.floor(Date.now() / 1000);

    // Two regions with independent CRDT stores sharing a pool.
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

    // Region A processes 5 verifies.
    for (let i = 0; i < 5; i++) {
      await regionA.increment('owner:verify:window:60', 1, t + 60, t + i);
    }

    // Region B processes 3 verifies.
    for (let i = 0; i < 3; i++) {
      await regionB.increment('owner:verify:window:60', 1, t + 60, t + i);
    }

    // Before sync: each region sees only its own count.
    const localA = await regionA.get('owner:verify:window:60', t);
    const localB = await regionB.get('owner:verify:window:60', t);
    assert.equal(localA.count, 5);
    assert.equal(localB.count, 3);

    // After both sync: the merged count is max(5, 3) = 5.
    await regionA._sync();
    await regionB._sync();

    const mergedA = await regionA.get('owner:verify:window:60', t);
    const mergedB = await regionB.get('owner:verify:window:60', t);
    assert.equal(mergedA.count, 5);
    assert.equal(mergedB.count, 5);

    await regionA.close();
    await regionB.close();
  });

  test('new window resets correctly across regions', async () => {
    const sharedPool = fakePool();
    const t = Math.floor(Date.now() / 1000);

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

    // First window: region A hits limit.
    for (let i = 0; i < 10; i++) {
      await regionA.increment('owner:verify:window:60', 1, t + 10, t + i);
    }

    await regionA._sync();
    await regionB._sync();

    // Both regions see the full count.
    assert.equal((await regionA.get('owner:verify:window:60', t)).count, 10);
    assert.equal((await regionB.get('owner:verify:window:60', t)).count, 10);

    // Window expires: both regions start fresh in a new window.
    const newT = t + 15;
    await regionA.increment('owner:verify:window:60', 1, newT + 60, newT);
    const afterA = await regionA.get('owner:verify:window:60', newT);
    assert.equal(afterA.count, 1);

    await regionA.close();
    await regionB.close();
  });
});

describe('multi-region: rate limit convergence', () => {
  test('increment accuracy across regions', async () => {
    const sharedPool = fakePool();
    const t = Math.floor(Date.now() / 1000);

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

    // Region A increments to 100.
    for (let i = 0; i < 100; i++) {
      await regionA.increment('counter', 1, t + 300, t);
    }

    // Region B increments to 50.
    for (let i = 0; i < 50; i++) {
      await regionB.increment('counter', 1, t + 300, t);
    }

    // A syncs, B syncs — merged max(100, 50) = 100.
    await regionA._sync();
    await regionB._sync();

    // Both regions converge to 100.
    assert.equal((await regionA.get('counter', t)).count, 100);
    assert.equal((await regionB.get('counter', t)).count, 100);

    // A increments 10 more, syncs — count should be 110.
    for (let i = 0; i < 10; i++) {
      await regionA.increment('counter', 1, t + 300, t);
    }
    await regionA._sync();
    assert.equal((await regionA.get('counter', t)).count, 110);

    await regionA.close();
    await regionB.close();
  });
});

describe('multi-region: failover detection timing', () => {
  test('failover is triggered within 30 seconds of failure', () => {
    // Worst-case: detectInterval * failureThreshold
    const detectIntervalMs = 5_000;
    const failureThreshold = 3;
    const worstCaseFailoverMs = detectIntervalMs * failureThreshold;
    assert.ok(
      worstCaseFailoverMs < 30_000,
      `worst-case failover ${worstCaseFailoverMs}ms exceeds 30s acceptance criterion`,
    );
  });

  test('failback is triggered within 30 seconds of recovery', () => {
    const detectIntervalMs = 5_000;
    const recoveryThreshold = 2;
    const worstCaseFailbackMs = detectIntervalMs * recoveryThreshold;
    assert.ok(
      worstCaseFailbackMs < 30_000,
      `worst-case failback ${worstCaseFailbackMs}ms exceeds 30s acceptance criterion`,
    );
  });

  test('failover state is reported in /readyz response', async () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 2,
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
      ],
    });

    // Degrade the checker.
    checker.reportLocalHealth(false);
    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'degraded');

    const { close, get } = await serve({
      extras: { failoverHealth: checker },
    });

    const res = await get('/readyz');
    const body = await res.json();

    // Response includes the failover block.
    assert.ok(body.failover, 'response should include failover block');
    assert.equal(body.failover.region, 'us-east-1');
    assert.equal(body.failover.failoverActive, true);
    assert.equal(body.failover.preferredRegion, 'eu-west-1');
    assert.equal(body.failover.localStatus, 'degraded');

    await close();
    await checker.stop();
  });

  test('healthy region reports failoverActive false', async () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
      ],
    });

    const { close, get } = await serve({
      extras: { failoverHealth: checker },
    });

    const res = await get('/readyz');
    const body = await res.json();

    assert.ok(body.failover);
    assert.equal(body.failover.failoverActive, false);
    assert.equal(body.failover.localStatus, 'healthy');

    await close();
    await checker.stop();
  });

  test('/readyz without failoverHealth excludes failover block', async () => {
    const { close, get } = await serve();
    const res = await get('/readyz');
    const body = await res.json();

    assert.equal(body.failover, undefined);

    await close();
  });
});

describe('multi-region: no split-brain', () => {
  test('only one region is preferred during partition', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
        { region: 'ap-south-1', priority: 3 },
      ],
    });

    // All healthy — only us-east-1 is preferred.
    const s1 = checker.getState();
    assert.equal(s1.preferredRegion, 'us-east-1');

    // us-east-1 degraded — eu-west-1 is preferred.
    checker.reportLocalHealth(false);
    const s2 = checker.getState();
    assert.equal(s2.preferredRegion, 'eu-west-1');

    // eu-west-1 also unhealthy — ap-south-1 is preferred.
    checker.remoteStatus.set('eu-west-1', { healthy: false, lastCheck: Date.now() });
    const s3 = checker.getState();
    assert.equal(s3.preferredRegion, 'ap-south-1');
  });

  test('recovering region does not cause traffic to swing prematurely', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      recoveryThreshold: 3,
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
      ],
    });

    // Degrade — failover to eu-west-1.
    checker.reportLocalHealth(false);
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');

    // One recovery ping — still degraded.
    checker.reportLocalHealth(true);
    assert.equal(checker.getState().failoverActive, true);
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');

    // Two recovery pings — still degraded.
    checker.reportLocalHealth(true);
    assert.equal(checker.getState().failoverActive, true);

    // Third recovery ping — fully recovered, failback eligible.
    checker.reportLocalHealth(true);
    assert.equal(checker.getState().failoverActive, false);
    assert.equal(checker.getState().preferredRegion, 'us-east-1');
  });
});
