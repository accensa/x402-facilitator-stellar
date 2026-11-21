/**
 * Repeated failures must not append duplicate dead-letter rows (#715).
 *
 * A message that fails delivery more than once used to land in `dead_letters`
 * once per failure, so the operator queue showed the same message repeatedly
 * and `delivery_attempts` no longer described a single row's history. The
 * store now upserts on `(message_id, source)`, keeping one row whose attempt
 * counter and latest failure details advance.
 *
 * The fake pool below carries enough SQL-shaped behaviour to exercise the
 * store's statements: an array of rows, the same upsert semantics the store
 * emits, and a merge pass for a legacy table that already contains duplicates.
 * It also records every statement so the conflict clause itself is pinned.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DeadLetterStore, DEAD_LETTERS_UNIQUE_INDEX_SQL } from '../src/dlq/store.js';

const MESSAGE = 'msg-715';

function fakePool({ seed = [] } = {}) {
  const rows = [];
  const queries = [];
  let nextId = 1;
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const timestamp = () => new Date((clock += 1000));
  const keyOf = (messageId, source) => `${messageId}\u0000${source}`;
  const findRow = (messageId, source) =>
    rows.find(row => row.message_id === messageId && row.source === source);

  for (const row of seed) {
    rows.push({
      type: null,
      error: null,
      first_failed_at: timestamp(),
      last_failed_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp(),
      ...row,
    });
    nextId = Math.max(nextId, row.id + 1);
  }

  const pool = {
    rows,
    queries,
    failUniqueIndex: false,
    async query(sql, params = []) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: flat, params });

      if (/CREATE TABLE/i.test(flat)) return { rows: [] };

      if (/CREATE UNIQUE INDEX/i.test(flat)) {
        if (pool.failUniqueIndex) {
          pool.failUniqueIndex = false;
          const err = new Error('could not create unique index: duplicate key value');
          err.code = '23505';
          throw err;
        }
        return { rows: [] };
      }

      if (/CREATE INDEX/i.test(flat)) return { rows: [] };

      if (/DELETE FROM dead_letters d USING ranked r/i.test(flat)) {
        const groups = new Map();
        for (const row of rows) {
          const key = keyOf(row.message_id, row.source);
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        for (const group of groups.values()) {
          if (group.length < 2) continue;
          group.sort((a, b) => a.id - b.id);
          const newest = group[group.length - 1];
          newest.delivery_attempts = group.reduce((sum, row) => sum + row.delivery_attempts, 0);
          newest.updated_at = timestamp();
          for (const row of group.slice(0, -1)) rows.splice(rows.indexOf(row), 1);
        }
        return { rows: [] };
      }

      if (/INSERT INTO dead_letters/i.test(flat)) {
        const [messageId, source, type, payloadJson, error, deliveryAttempts] = params;
        const existing = findRow(messageId, source);
        if (existing) {
          existing.delivery_attempts += 1;
          existing.type = type ?? existing.type;
          existing.payload = JSON.parse(payloadJson);
          existing.error = error;
          existing.last_failed_at = timestamp();
          existing.updated_at = existing.last_failed_at;
          return { rows: [{ id: existing.id }] };
        }

        const at = timestamp();
        const row = {
          id: nextId++,
          message_id: messageId,
          source,
          type,
          payload: JSON.parse(payloadJson),
          error,
          delivery_attempts: deliveryAttempts,
          first_failed_at: at,
          last_failed_at: at,
          created_at: at,
          updated_at: at,
        };
        rows.push(row);
        return { rows: [{ id: row.id }] };
      }

      return { rows: [] };
    },
  };

  return pool;
}

describe('DeadLetterStore.insert dedupe (#715)', () => {
  test('repeated failures for one (message_id, source) update a single row', async () => {
    const pool = fakePool();
    const store = new DeadLetterStore(pool);
    await store.ready;

    const firstId = await store.insert({
      messageId: MESSAGE,
      source: 'outbox',
      type: 'settlement',
      payload: { attempt: 1 },
      error: 'timeout',
      deliveryAttempts: 2,
    });
    const first = { ...pool.rows[0] };

    const secondId = await store.insert({
      messageId: MESSAGE,
      source: 'outbox',
      type: 'settlement',
      payload: { attempt: 2 },
      error: 'connection refused',
      deliveryAttempts: 2,
    });
    const thirdId = await store.insert({
      messageId: MESSAGE,
      source: 'outbox',
      type: 'settlement',
      payload: { attempt: 3 },
      error: 'dns failure',
      deliveryAttempts: 2,
    });

    assert.equal(pool.rows.length, 1, 'duplicate failures must not append rows');
    assert.equal(secondId, firstId, 'the existing row id is returned on conflict');
    assert.equal(thirdId, firstId);

    const row = pool.rows[0];
    assert.equal(row.delivery_attempts, 4, 'attempts increment from 2 to 4');
    assert.equal(row.error, 'dns failure', 'the latest error is retained');
    assert.deepEqual(row.payload, { attempt: 3 });
    assert.equal(row.first_failed_at, first.first_failed_at, 'first failure time is preserved');
    assert.ok(row.last_failed_at > first.last_failed_at, 'last_failed_at is refreshed');
    assert.ok(row.updated_at > first.updated_at, 'updated_at is refreshed');

    const insertSql = pool.queries.find(query => /INSERT INTO dead_letters/i.test(query.sql)).sql;
    assert.match(insertSql, /ON CONFLICT \(message_id, source\) DO UPDATE/);
    assert.match(insertSql, /delivery_attempts = dead_letters\.delivery_attempts \+ 1/);
  });

  test('different sources or message ids remain distinct rows', async () => {
    const pool = fakePool();
    const store = new DeadLetterStore(pool);
    await store.ready;

    await store.insert({ messageId: MESSAGE, source: 'outbox', payload: {} });
    await store.insert({ messageId: MESSAGE, source: 'direct', payload: {} });
    await store.insert({ messageId: 'msg-other', source: 'outbox', payload: {} });

    assert.equal(pool.rows.length, 3, 'uniqueness is on the (message_id, source) pair');
    assert.equal(
      pool.rows.find(row => row.message_id === MESSAGE && row.source === 'outbox')
        .delivery_attempts,
      0,
    );
    assert.equal(
      pool.rows.find(row => row.message_id === MESSAGE && row.source === 'direct')
        .delivery_attempts,
      0,
    );
    assert.equal(
      pool.rows.find(row => row.message_id === 'msg-other' && row.source === 'outbox')
        .delivery_attempts,
      0,
    );
  });

  test('the store defines a unique index on (message_id, source)', () => {
    assert.match(DEAD_LETTERS_UNIQUE_INDEX_SQL, /CREATE UNIQUE INDEX IF NOT EXISTS/);
    assert.match(DEAD_LETTERS_UNIQUE_INDEX_SQL, /\(message_id, source\)/);
  });

  test('existing duplicate rows are merged before the unique index is created', async () => {
    const pool = fakePool({
      seed: [
        {
          id: 1,
          message_id: MESSAGE,
          source: 'outbox',
          payload: {},
          error: 'old error',
          delivery_attempts: 2,
        },
        {
          id: 2,
          message_id: MESSAGE,
          source: 'outbox',
          payload: {},
          error: 'new error',
          delivery_attempts: 3,
        },
      ],
    });
    pool.failUniqueIndex = true;
    const warnings = [];
    const store = new DeadLetterStore(pool, { warn: message => warnings.push(message) });
    await store.ready;

    assert.equal(pool.rows.length, 1, 'legacy duplicates are collapsed to one row');
    assert.equal(pool.rows[0].id, 2, 'the newest row survives with its latest error');
    assert.equal(pool.rows[0].error, 'new error');
    assert.equal(pool.rows[0].delivery_attempts, 5, 'attempts across duplicates are summed');
    assert.equal(warnings.length, 1, 'the merge is reported through the warn sink');
  });
});
