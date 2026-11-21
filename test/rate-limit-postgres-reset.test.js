/**
 * PostgresStore reset timestamps are read from the snake_case `reset_at`
 * column (#761).
 *
 * node-postgres surfaces BIGINT columns as strings (parseInt8 is off by
 * default) and always uses the SQL column name — `reset_at` — never the
 * camelCase `resetAt`. Every bucket previously read `rows[0].resetAt`
 * (undefined → Number(undefined) → NaN), so the shared limiter computed
 * Retry-After: NaN and could never observe a window expire. These tests pin
 * the parsed values through the public get()/increment() surface using a
 * mock pool shaped like a real one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/rate-limit-store.js';

/**
 * A pool whose query() answers with pre-baked pg-shaped rows: BIGINT values
 * as they arrive from pg (strings, or BigInts where a pool parses int8).
 */
function pgMockPool(rows) {
  return {
    async query() {
      return { rows };
    },
  };
}

function assertPositiveResetAt(bucket) {
  assert.ok(bucket, 'a live bucket must be returned');
  assert.ok(Number.isFinite(bucket.resetAt), `resetAt must be finite, got ${bucket.resetAt}`);
  assert.ok(
    Number.isSafeInteger(bucket.resetAt),
    `resetAt must be a safe integer, got ${bucket.resetAt}`,
  );
  assert.ok(bucket.resetAt > 0, `resetAt must be positive, got ${bucket.resetAt}`);
}

describe('PostgresStore parses the snake_case reset_at column (#761)', () => {
  test('get() returns a valid numeric resetAt when the row is live', async () => {
    const store = new PostgresStore({ pool: pgMockPool([{ count: '2', reset_at: '2200' }]) });
    const bucket = await store.get('b1', 1000);
    assert.equal(bucket.count, 2);
    assertPositiveResetAt(bucket);
    assert.equal(bucket.resetAt, 2200);
  });

  test('increment() returns a valid numeric resetAt', async () => {
    const store = new PostgresStore({ pool: pgMockPool([{ count: '3', reset_at: '2000' }]) });
    const bucket = await store.increment('b1', 2, 2000, 1000);
    assert.equal(bucket.count, 3);
    assertPositiveResetAt(bucket);
    assert.equal(bucket.resetAt, 2000);
  });

  test('a camelCase row from an aliasing pool still parses (defensive fallback)', async () => {
    const store = new PostgresStore({ pool: pgMockPool([{ count: '1', resetAt: 1500 }]) });
    const bucket = await store.get('b1', 1000);
    assertPositiveResetAt(bucket);
    assert.equal(bucket.resetAt, 1500);
  });

  test('BIGINT values arriving as strings or BigInts parse to safe positive integers', async () => {
    const asString = new PostgresStore({ pool: pgMockPool([{ count: '5', reset_at: '60000' }]) });
    assertPositiveResetAt(await asString.get('b', 10));

    const asBigint = new PostgresStore({
      pool: pgMockPool([{ count: 6n, reset_at: 60000n }]),
    });
    const bucket = await asBigint.increment('b', 1, 60000, 10);
    assertPositiveResetAt(bucket);
    assert.equal(bucket.resetAt, 60000);
  });
});
