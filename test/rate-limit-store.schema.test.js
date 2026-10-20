import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/rate-limit-store.js';

test('PostgresStore bootstraps the table and reset_at index idempotently', async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      return { rows: [] };
    },
  };

  await new PostgresStore({ pool }).ready;
  await new PostgresStore({ pool }).ready;

  assert.equal(queries.length, 2);
  for (const sql of queries) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS rate_limit_buckets/);
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_reset_at ON rate_limit_buckets\(reset_at\)/,
    );
  }
});
