/**
 * The shared rate-limit store (issue #94).
 *
 * What is under test is the move itself: the limiter's public surface is
 * unchanged, in-memory remains the zero-config default with today's exact
 * behaviour, a shared store makes two limiter instances enforce ONE combined
 * limit, the daily fee counter survives a "restart", increments lose no counts
 * under concurrency, and an unreachable shared store fails closed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { MemoryStore, PostgresStore, createRateLimitStore } from '../src/rate-limit-store.js';

const LIMITS = {
  global: { verifyRpm: 2, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 1000 },
  keys: {},
};

test('with no store configured, behaviour is exactly per-process memory', async () => {
  const limiter = new RateLimiter(LIMITS);
  assert.ok(limiter.store instanceof MemoryStore);
  const req = { keyId: 'k' };
  await limiter.recordVerify(req);
  await limiter.recordVerify(req);
  assert.equal((await limiter.checkVerify(req)).allowed, false);
});

describe('two instances against one store enforce one combined limit', () => {
  test('counters are shared across limiters', async () => {
    const store = new MemoryStore();
    const a = new RateLimiter(LIMITS, store);
    const b = new RateLimiter(LIMITS, store);
    const req = { keyId: 'shared_key' };

    // verifyRpm is 2: instance A spends one slot, instance B spends the other,
    // and either instance must now see the window as exhausted.
    await a.recordVerify(req);
    await b.recordVerify(req);
    assert.equal((await a.checkVerify(req)).allowed, false);
    assert.equal((await b.checkVerify(req)).allowed, false);

    // And usage read through either instance reports the combined count.
    assert.equal(await (await a.getUsage(req.keyId)).verify_rpm, 2);
    assert.equal(await (await b.getUsage(req.keyId)).verify_rpm, 2);
  });

  test('the fee ceiling is combined too', async () => {
    const store = new MemoryStore();
    // Request counts stay far below their caps so the FEE ceiling is the
    // binding constraint here.
    const limits = {
      global: { verifyRpm: 10, settleRpm: 10, settleRph: 100, settleRpd: 1000, feeSpd: 600 },
      keys: {},
    };
    const a = new RateLimiter(limits, store);
    const b = new RateLimiter(limits, store);
    const req = { keyId: 'payer' };

    await a.recordSettle(req, 400);
    await b.recordSettle(req, 300); // 700 total across replicas
    const res = await b.checkSettle(req);
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'fee_ceiling_exceeded');
  });
});

describe('the daily fee counter survives a restart', () => {
  test('a fresh limiter over the same store reads prior spend', async () => {
    const store = new MemoryStore();
    const limits = {
      global: { verifyRpm: 10, settleRpm: 10, settleRph: 100, settleRpd: 1000, feeSpd: 500 },
      keys: {},
    };
    const before = new RateLimiter(limits, store);
    await before.recordSettle({ keyId: 'k' }, 700);

    // "Restart": throw the limiter away, keep the store — what a process
    // restart does when the store outlives it.
    const after = new RateLimiter(limits, store);
    const usage = await after.getUsage('k');
    assert.equal(usage.fee_spd, 700);

    // GET /usage is how acceptance verifies it end to end.
    const res = await after.checkSettle({ keyId: 'k' });
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'fee_ceiling_exceeded');
  });

  test('PostgresStore rows persist across a pool replacement', async () => {
    const pool = fakePool();
    const first = new PostgresStore({ pool });
    const limiterA = new RateLimiter(LIMITS, first);
    await limiterA.recordSettle({ keyId: 'k' }, 900);

    // A restart builds a brand-new pool and brand-new store over the same data.
    const second = new PostgresStore({ pool });
    const usage = await new RateLimiter(LIMITS, second).getUsage('k');
    assert.equal(usage.fee_spd, 900);
  });
});

test('increments are atomic — concurrent writes lose no count', async () => {
  const store = new MemoryStore();
  const a = new RateLimiter(LIMITS, store);
  const b = new RateLimiter(LIMITS, store);

  // Two replicas taking interleaved traffic for the same caller.
  await Promise.all([
    ...Array.from({ length: 25 }, () => a._increment('concurrent', 'verify', 60, 1)),
    ...Array.from({ length: 25 }, () => b._increment('concurrent', 'verify', 60, 1)),
  ]);

  const usage = await a.getUsage('concurrent');
  assert.equal(usage.verify_rpm, 50, '50 increments must land as 50');
});

describe('an unreachable shared store degrades deliberately — fail CLOSED', () => {
  /**
   * WHY fail-closed and not fail-open. The only reason to configure a shared
   * store is that the limits matter; feeSpd is the sole spend control over
   * sponsored fees. A limiter that cannot see its counters has no idea whether
   * the ceiling is spent, so answering "allowed" would re-create the unlimited-
   * spend bug this issue exists to fix. Checks refuse; records (which run after
   * a payment already succeeded) degrade open but log loudly.
   */
  class BrokenStore extends MemoryStore {
    async get() {
      throw new Error('connection refused');
    }
    async increment() {
      throw new Error('connection refused');
    }
  }

  test('checks refuse with a distinct reason code', async () => {
    const limiter = new RateLimiter(LIMITS, new BrokenStore());
    const req = { keyId: 'k' };

    const v = await limiter.checkVerify(req);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'rate_limit_store_unavailable');

    const s = await limiter.checkSettle(req);
    assert.equal(s.allowed, false);
    assert.equal(s.reason, 'rate_limit_store_unavailable');

    const c = await limiter.checkCatalog(req);
    assert.equal(c.allowed, false);
    assert.equal(c.reason, 'rate_limit_store_unavailable');
  });

  test('the fee-ceiling check does not misreport a dead store as fee_ceiling_exceeded', async () => {
    const limiter = new RateLimiter(LIMITS, new BrokenStore());
    const res = await limiter.checkSettle({ keyId: 'k' });
    assert.notEqual(res.reason, 'fee_ceiling_exceeded');
  });

  test('records do not throw — a settled payment must not become a 5xx', async () => {
    const limiter = new RateLimiter(LIMITS, new BrokenStore());
    await assert.doesNotReject(() => limiter.recordSettle({ keyId: 'k' }, 100));
    await assert.doesNotReject(() => limiter.recordVerify({ keyId: 'k' }));
    await assert.doesNotReject(() => limiter.getUsage('k'));
  });
});

describe('PostgresStore statement semantics', () => {
  test('increment uses one atomic upsert, not read-modify-write', async () => {
    const pool = fakePool();
    const store = new PostgresStore({ pool });
    await store.increment('b1', 3, 2000, 1000);
    const bucket = await store.get('b1', 1500);
    assert.equal(bucket.count, 3);

    // The write must be a single INSERT ... ON CONFLICT DO UPDATE RETURNING.
    const upserts = pool.queries.filter(q => q.sql.includes('ON CONFLICT'));
    assert.equal(upserts.length, 1);
    assert.match(upserts[0].sql, /RETURNING count, reset_at/);
  });

  test('an expired row reused after its window rolls over starts from zero', async () => {
    const pool = fakePool();
    const store = new PostgresStore({ pool });
    await store.increment('b2', 5, 1100, 1000); // expires at 1100

    // Window rolled over; same bucket_id shape can recur with a new resetAt.
    const bucket = await store.increment('b2', 2, 2200, 1200);
    assert.equal(bucket.count, 2, 'must not accumulate onto the expired window');
  });

  test('get ignores expired buckets', async () => {
    const pool = fakePool();
    const store = new PostgresStore({ pool });
    await store.increment('b3', 5, 1100, 1000);
    const live = await store.get('b3', 999);
    assert.equal(live.count, 5, 'resetAt 1100 > 999, still live');
    assert.deepEqual(await store.get('b3', 1500), undefined);
  });

  test('sweep deletes only expired rows', async () => {
    const pool = fakePool();
    const store = new PostgresStore({ pool });
    await store.increment('live', 1, 5000, 1000);
    await store.increment('dead', 1, 900, 1000);
    await store.sweep(1000);
    assert.ok(await store.get('live', 1000));
    assert.equal(await store.get('dead', 1000), undefined);
  });
});

describe('store selection', () => {
  test('unset RATE_LIMIT_STORE means memory', () => {
    const store = createRateLimitStore({});
    assert.ok(store instanceof MemoryStore);
  });

  test('RATE_LIMIT_STORE=postgres without DATABASE_URL refuses to start', () => {
    assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'postgres' }), /DATABASE_URL/);
  });

  test('an unknown store name is a configuration error, not a silent fallback', () => {
    assert.throws(
      () => createRateLimitStore({ RATE_LIMIT_STORE: 'redis' }),
      /Unknown RATE_LIMIT_STORE/,
    );
  });
});

test('GET /usage over HTTP reads the fee counter that survived a restart', async () => {
  // End-to-end form of the restart-survival acceptance item: spend is recorded
  // by one process-shaped limiter, then GET /usage is served by a fresh
  // limiter instance over the same store — what a restarted process is.
  const { serve, testConfig, stubFacilitator } = await import('./helpers/app.js');
  const store = new MemoryStore();
  const limits = {
    global: { verifyRpm: 10, settleRpm: 10, settleRph: 100, settleRpd: 1000, feeSpd: 5000 },
    keys: {},
  };
  // Key ids are normalized to uppercase at auth, so the record must be
  // written under the same normalized id the /usage handler looks up.
  await new RateLimiter(limits, store).recordSettle({ keyId: 'ADMIN' }, 1234);

  const app = await serve({
    config: testConfig({ apiKeys: ['admin:s3cret'] }),
    facilitator: stubFacilitator(),
    rateLimiter: new RateLimiter(limits, store), // fresh limiter, shared store
  });
  try {
    const res = await app.get('/usage', { authorization: 'Bearer s3cret' });
    assert.equal(res.status, 200);
    const usage = await res.json();
    assert.equal(usage.fee_spd, 1234);
  } finally {
    await app.close();
  }
});

/**
 * A minimal emulation of the pg Pool surface, implementing exactly the three
 * statements PostgresStore issues. This pins the SQL semantics (atomic upsert,
 * expiry handling) without standing up a live server; a real deployment still
 * needs the migration applied or the store's CREATE TABLE IF NOT EXISTS.
 */
function fakePool() {
  const table = new Map(); // bucket_id -> { count, reset_at }
  return {
    table,
    queries: [],
    async query(sql, params = []) {
      this.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('CREATE TABLE IF NOT EXISTS')) return { rows: [] };
      if (sql.startsWith('SELECT count, reset_at')) {
        const [id, now] = params;
        const row = table.get(id);
        if (!row || row.reset_at <= Number(now)) return { rows: [] };
        return { rows: [{ count: row.count, reset_at: row.reset_at }] };
      }
      if (sql.includes('ON CONFLICT (bucket_id) DO UPDATE')) {
        const [id, amount, resetAt, now] = [
          params[0],
          Number(params[1]),
          Number(params[2]),
          Number(params[3]),
        ];
        let row = table.get(id);
        if (!row || row.reset_at <= now) row = { count: 0 };
        else row = { ...row };
        row.count += amount;
        row.reset_at = resetAt;
        table.set(id, row);
        return { rows: [{ count: row.count, reset_at: row.reset_at }] };
      }
      if (sql.startsWith('DELETE FROM rate_limit_buckets')) {
        const [now] = params.map(Number);
        for (const [id, row] of table.entries()) {
          if (row.reset_at <= now) table.delete(id);
        }
        return { rowCount: 0 };
      }
      throw new Error(`fakePool: unexpected statement ${sql}`);
    },
  };
}
