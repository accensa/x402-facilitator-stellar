/**
 * DLQ purge status validation (#706).
 *
 * DeadLetterManager.purge pushed any truthy `status` straight into the SQL
 * conditions, so a typo ('exhaustd') produced a DELETE whose WHERE clause could
 * never match and the operator saw a silent `{ purged: 0 }`. The manager now
 * validates the status against the allowed set before touching the database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DeadLetterManager } from '../src/dlq/manager.js';

function stubStore() {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  return { queries, pool };
}

describe('DeadLetterManager.purge status validation (#706)', () => {
  test('each allowed status runs the delete against that status', async () => {
    for (const status of ['pending', 'exhausted', 'resolved', 'discarded']) {
      const store = stubStore();
      const mgr = new DeadLetterManager(store);
      const result = await mgr.purge({ status });
      assert.equal(result.purged, 0);
      assert.equal(store.queries.length, 1);
      assert.match(store.queries[0].sql, /DELETE FROM dead_letters WHERE status = \$1/);
      assert.deepEqual(store.queries[0].params, [status]);
    }
  });

  test('an unknown status is rejected before any query runs', async () => {
    const store = stubStore();
    const mgr = new DeadLetterManager(store);
    await assert.rejects(
      () => mgr.purge({ status: 'exhaustd' }),
      /Invalid DLQ purge status[\s\S]*Allowed statuses are/,
    );
    assert.equal(store.queries.length, 0, 'no delete may run for an unknown status');
  });

  test('an unknown status naming a real-but-misspelled state is rejected too', async () => {
    const store = stubStore();
    const mgr = new DeadLetterManager(store);
    await assert.rejects(() => mgr.purge({ status: 'resovled' }), /status/);
    assert.equal(store.queries.length, 0);
  });

  test('purge still honours an olderThan filter without a status', async () => {
    const store = stubStore();
    const mgr = new DeadLetterManager(store);
    const result = await mgr.purge({ olderThan: '2026-01-01T00:00:00.000Z' });
    assert.equal(result.purged, 0);
    assert.equal(store.queries.length, 1);
    assert.match(store.queries[0].sql, /DELETE FROM dead_letters WHERE created_at < \$1/);
  });
});
