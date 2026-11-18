/**
 * CRDT rate limit merge across the pg BIGINT boundary (#762).
 *
 * `reset_at` and `count` are BIGINT columns. node-postgres returns 64-bit
 * integers as strings, so the store was comparing `'1731600060' === 1731600060`
 * and never merging remote state into a live local counter — cross-region
 * increments were silently ignored on reads. The fake pool here deliberately
 * returns strings, the way pg does, which the older fake pool did not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CrdtRateLimitStore } from '../src/crdt-rate-limit-store.js';

const NOW = 1_731_600_000;

/**
 * Fake pg Pool whose SELECT returns a BIGINT-shaped row: strings for `count`
 * and `reset_at`.
 */
function fakePool(row, { failSelect = false } = {}) {
  const selects = [];
  return {
    selects,
    async query(sql, params) {
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
      if (/SELECT/.test(sql)) {
        selects.push({ sql, params });
        if (failSelect) throw new Error('connection refused');
        return { rows: row ? [{ ...row }] : [] };
      }
      return { rows: [] };
    },
    async end() {},
    on() {},
  };
}

function store(pool) {
  return new CrdtRateLimitStore({
    region: 'eu-west-1',
    pool,
    syncIntervalMs: 60_000, // long — the test never waits for a sync tick
  });
}

describe('CrdtRateLimitStore string BIGINT comparison', () => {
  test('merges remote string reset_at with a live local numeric window', async () => {
    const pool = fakePool({ count: '7', reset_at: String(NOW + 60) });
    const crdt = store(pool);

    // Local has already counted 3 in this window; another region reports 7.
    crdt.local.set('bucket', { count: 3, resetAt: NOW + 60 });

    const got = await crdt.get('bucket', NOW);

    assert.equal(got.count, 7, 'remote count must win the G-Counter max merge');
    assert.equal(got.resetAt, NOW + 60);
    assert.equal(typeof got.resetAt, 'number', 'merged resetAt must not leak a string');
    await crdt.close();
  });

  test('keeps the larger local count when remote is behind in the same window', async () => {
    const pool = fakePool({ count: '2', reset_at: String(NOW + 60) });
    const crdt = store(pool);
    crdt.local.set('bucket', { count: 9, resetAt: NOW + 60 });

    const got = await crdt.get('bucket', NOW);

    assert.equal(got.count, 9);
    assert.equal(got.resetAt, NOW + 60);
    assert.equal(typeof got.resetAt, 'number');
    await crdt.close();
  });

  test('uses remote string reset_at when local has no live counter', async () => {
    const pool = fakePool({ count: '12', reset_at: String(NOW + 120) });
    const crdt = store(pool);

    // No local entry: the expired/missing branch queries the database.
    const got = await crdt.get('bucket', NOW);

    assert.equal(got.count, 12, 'string count must be parsed before returning');
    assert.equal(got.resetAt, NOW + 120);
    assert.equal(typeof got.resetAt, 'number');
    assert.equal(pool.selects.length, 1, 'the remote row must actually be read');
    await crdt.close();
  });

  test('ignores a remote window that has already expired', async () => {
    const pool = fakePool({ count: '12', reset_at: String(NOW - 1) });
    const crdt = store(pool);

    const got = await crdt.get('bucket', NOW);

    assert.equal(got, undefined, 'an expired remote row must not resurrect a bucket');
    await crdt.close();
  });

  test('does not merge a remote row from a different window', async () => {
    const pool = fakePool({ count: '99', reset_at: String(NOW + 120) });
    const crdt = store(pool);
    crdt.local.set('bucket', { count: 4, resetAt: NOW + 60 });

    const got = await crdt.get('bucket', NOW);

    assert.equal(got.count, 4, 'different windows are separate counters');
    assert.equal(got.resetAt, NOW + 60);
    await crdt.close();
  });

  test('degrades to local state when the remote read fails', async () => {
    const pool = fakePool({ count: '99', reset_at: String(NOW + 60) }, { failSelect: true });
    const crdt = store(pool);
    crdt.local.set('bucket', { count: 4, resetAt: NOW + 60 });

    const got = await crdt.get('bucket', NOW);

    assert.equal(got.count, 4);
    assert.equal(got.resetAt, NOW + 60);
    assert.equal(crdt.degraded, true, 'a failed read must mark the store degraded');
    await crdt.close();
  });
});
