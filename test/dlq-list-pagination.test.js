/**
 * GET /admin/dlq pagination reporting (#580).
 *
 * The route used to echo the raw query numbers while `DeadLetterStore.list`
 * clamped them independently, so `?limit=9999` answered `pagination.limit`
 * 9999 while returning at most 200 items. These tests drive the route over the
 * real HTTP surface with a stub DLQ and pin the reported values to the query
 * that actually ran.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, testConfig, TEST_SECRET } from './helpers/app.js';

const AUTH = { authorization: `Bearer ${TEST_SECRET}` };
const ROWS = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, message_id: `m-${i + 1}` }));

/** Stub shaped like DeadLetterStore for the list route only. */
function dlqStub() {
  const calls = [];
  return {
    calls,
    list: async ({ status, limit, offset }) => {
      calls.push({ status, limit, offset });
      return { items: ROWS.slice(offset, offset + limit), total: ROWS.length };
    },
  };
}

async function withDlq(fn) {
  const dlq = dlqStub();
  const app = await serve({
    config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }),
    extras: { dlq: { store: dlq, publish: async () => {} } },
  });
  try {
    await fn(app, dlq);
  } finally {
    await app.close();
  }
}

describe('GET /admin/dlq pagination (#580)', () => {
  test('an over-cap limit reports the applied 200 and returns at most that many items', async () => {
    await withDlq(async (app, dlq) => {
      const res = await app.get('/admin/dlq?limit=9999', AUTH);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.pagination.limit, 200);
      assert.equal(body.pagination.offset, 0);
      assert.equal(body.pagination.total, ROWS.length);
      assert.equal(body.items.length, 200, 'at most the applied limit is returned');
      assert.deepEqual(dlq.calls[0], { status: null, limit: 200, offset: 0 });
    });
  });

  test('limit=0 reports the applied floor of 1', async () => {
    await withDlq(async (app, dlq) => {
      const res = await app.get('/admin/dlq?limit=0', AUTH);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.pagination.limit, 1);
      assert.equal(body.items.length, 1);
      assert.deepEqual(dlq.calls[0], { status: null, limit: 1, offset: 0 });
    });
  });

  test('a negative offset reports the applied 0', async () => {
    await withDlq(async (app, dlq) => {
      const res = await app.get('/admin/dlq?offset=-5', AUTH);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.pagination.offset, 0);
      assert.equal(body.pagination.limit, 50);
      assert.deepEqual(dlq.calls[0], { status: null, limit: 50, offset: 0 });
    });
  });

  test('missing and non-numeric values keep the documented defaults', async () => {
    await withDlq(async (app, dlq) => {
      const res = await app.get('/admin/dlq', AUTH);
      assert.equal(res.status, 200);
      let body = await res.json();
      assert.equal(body.pagination.limit, 50);
      assert.equal(body.pagination.offset, 0);
      assert.deepEqual(dlq.calls[0], { status: null, limit: 50, offset: 0 });

      const nonNumeric = await app.get('/admin/dlq?limit=abc&offset=xyz', AUTH);
      assert.equal(nonNumeric.status, 200);
      body = await nonNumeric.json();
      assert.equal(body.pagination.limit, 50);
      assert.equal(body.pagination.offset, 0);
      assert.deepEqual(dlq.calls[1], { status: null, limit: 50, offset: 0 });
    });
  });
});
