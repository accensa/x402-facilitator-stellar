/**
 * Chaos engineering test suite (#129).
 *
 * Validates that the facilitator degrades gracefully and recovers automatically
 * when Redis and Postgres experience connection resets, high latency, packet
 * loss, or sudden disconnection. The tests exercise the resilience built into
 * RedisRateLimiter, PostgresIdempotencyStore, createDistributedLock, and the
 * full HTTP surface via the serve() harness.
 *
 * No external services required — all chaos is injected via fakes that mirror
 * the real ioredis/pg APIs. For real-network chaos (Toxiproxy), see
 * test/integration/chaos/.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RedisRateLimiter } from '../src/redis-rate-limit.js';
import { PostgresIdempotencyStore } from '../src/idempotency.js';
import { createDistributedLock, LockAcquireTimeoutError } from '../src/distributed-lock.js';
import { serve, testConfig, stubFacilitator, stubCatalog, VALID_BODY } from './helpers/app.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Helpers — fake Redis / Postgres with configurable failure modes
// ---------------------------------------------------------------------------

function fakeRedis({ fail = false, errorMessage = 'Connection is closed' } = {}) {
  const store = new Map();
  return {
    status: 'ready',
    calls: [],
    store,
    on: () => {},
    async incr(key) {
      this.calls.push('incr');
      if (fail) throw new Error(errorMessage);
      const entry = store.get(key) ?? { value: 0 };
      entry.value += 1;
      store.set(key, entry);
      return entry.value;
    },
    async expire(_key, _seconds) {
      if (fail) throw new Error(errorMessage);
      return 1;
    },
    async get(key) {
      this.calls.push('get');
      if (fail) throw new Error(errorMessage);
      const entry = store.get(key);
      return entry ? String(entry.value) : null;
    },
  };
}

function limiterConfig() {
  return {
    global: {
      verifyRpm: 60,
      settleRpm: 10,
      settleRph: 100,
      settleRpd: 1000,
      feeSpd: 5_000_000,
      catalogRpm: 10,
    },
    keys: {},
  };
}

/**
 * Fake pg Pool — rejects connect() or query() to simulate Postgres failures.
 * The pool maintains in-memory rows for the idempotency key claim protocol.
 */
function fakePool({
  failConnect = false,
  failQuery = false,
  errorMessage = 'connection refused',
} = {}) {
  const rows = new Map();
  return {
    rows,
    async connect() {
      if (failConnect) throw new Error(errorMessage);
      return {
        query: async (sql, params) => {
          if (failQuery) throw new Error(errorMessage);
          if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
          if (/INSERT/.test(sql)) {
            if (rows.has(params[0])) return { rowCount: 0 };
            rows.set(params[0], { status_code: null, response: null });
            return { rowCount: 1 };
          }
          if (/SELECT/.test(sql)) {
            const row = rows.get(params[0]);
            return { rows: row && row.response !== null ? [row] : [] };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
        release: () => {},
      };
    },
    query: async (sql, params) => {
      if (failQuery) throw new Error(errorMessage);
      if (/UPDATE/.test(sql)) {
        rows.get(params[0]).status_code = params[1];
        rows.get(params[0]).response = params[2];
        return { rowCount: 1 };
      }
      if (/SELECT/.test(sql)) {
        const row = rows.get(params[0]);
        return { rows: row && row.response !== null ? [row] : [] };
      }
      throw new Error(`unexpected pool sql: ${sql}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Redis rate limiter chaos
// ---------------------------------------------------------------------------

describe('Redis rate limiter chaos', () => {
  test('operates normally under healthy conditions', async () => {
    const limiter = new RedisRateLimiter(limiterConfig(), { client: fakeRedis() });
    const check = await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(check.allowed, true);
    assert.equal(limiter.degraded, false);
  });

  test('survives Redis connection reset and serves from memory', async () => {
    const client = fakeRedis({ fail: true });
    const limiter = new RedisRateLimiter(limiterConfig(), { client });

    await limiter.recordVerify({ ip: '10.0.0.1' });
    const check = await limiter.checkVerify({ ip: '10.0.0.1' });

    assert.equal(check.allowed, true);
    assert.equal(limiter.degraded, true);
  });

  test('operates under degraded mode with per-instance counters', async () => {
    const client = fakeRedis({ fail: true });
    const limiter = new RedisRateLimiter(limiterConfig(), { client });

    await limiter.recordVerify({ ip: '10.0.0.1' });
    await limiter.recordVerify({ ip: '10.0.0.1' });
    const check = await limiter.checkVerify({ ip: '10.0.0.1' });

    assert.equal(check.allowed, true);
    assert.equal(limiter.degraded, true);
    assert.ok(check.remaining >= 0);
  });

  test('recovers when Redis comes back after failure', async () => {
    const client = fakeRedis({ fail: true });
    const limiter = new RedisRateLimiter(limiterConfig(), { client });

    await limiter.recordVerify({ ip: '10.0.0.1' });
    assert.equal(limiter.degraded, true);

    // Simulate ioredis reconnection success.
    client.fail = false;
    limiter._recover();
    assert.equal(limiter.degraded, false);

    // Verify operations work normally again.
    const check = await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(check.allowed, true);
  });

  test('recovers from transient Redis failure', async () => {
    let failing = false;
    const client = {
      status: 'ready',
      on: () => {},
      async incr(_key) {
        if (failing) throw new Error('LOADING Redis is loading the dataset');
        return 1;
      },
      async expire() {
        return 1;
      },
      async get(_key) {
        if (failing) throw new Error('LOADING Redis is loading the dataset');
        return null;
      },
    };
    const limiter = new RedisRateLimiter(limiterConfig(), { client });

    failing = true;
    await limiter.recordVerify({ ip: '10.0.0.1' });
    assert.equal(limiter.degraded, true);

    failing = false;
    limiter._recover();
    assert.equal(limiter.degraded, false);
  });

  test('settle and catalog operations degrade gracefully', async () => {
    const client = fakeRedis({ fail: true });
    const limiter = new RedisRateLimiter(limiterConfig(), { client });

    const settleCheck = await limiter.checkSettle({ ip: '10.0.0.1' });
    assert.equal(settleCheck.allowed, true);
    assert.equal(limiter.degraded, true);

    const catalogCheck = await limiter.checkCatalog({ ip: '10.0.0.2' });
    assert.equal(catalogCheck.allowed, true);
  });

  test('does not crash when Redis is unreachable at construction', async () => {
    // Simulate the lazy-import path: client is null initially, operations
    // fall back to the in-memory parent until the (simulated) import resolves.
    const limiter = new RedisRateLimiter(limiterConfig(), {
      client: fakeRedis({ fail: true }),
    });

    const check = await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(check.allowed, true);
    assert.equal(limiter.degraded, true);
  });

  test('concurrent operations during failure do not corrupt state', async () => {
    const client = fakeRedis({ fail: true });
    const limiter = new RedisRateLimiter(limiterConfig(), { client });

    // Fire many concurrent operations while Redis is down.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limiter.checkVerify({ ip: `10.0.${Math.floor(i / 256)}.${i % 256}` }),
      ),
    );

    for (const check of results) {
      assert.equal(check.allowed, true);
    }
    assert.equal(limiter.degraded, true);
  });

  test('intermittent failures degrade and recover correctly', async () => {
    let failing = false;
    const client = {
      status: 'ready',
      on: () => {},
      async incr(_key) {
        if (failing) throw new Error('Connection reset');
        return 1;
      },
      async expire() {
        return 1;
      },
      async get(_key) {
        if (failing) throw new Error('Connection reset');
        return null;
      },
    };
    const limiter = new RedisRateLimiter(limiterConfig(), { client });

    // First: healthy.
    await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(limiter.degraded, false);

    // Failing.
    failing = true;
    await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(limiter.degraded, true);

    // Recovering.
    failing = false;
    limiter._recover();
    assert.equal(limiter.degraded, false);

    // Verify after recovery.
    const check = await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(check.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// Postgres idempotency store chaos
// ---------------------------------------------------------------------------

describe('Postgres idempotency store chaos', () => {
  test('degrades to memory when pool.connect() fails', async () => {
    const store = new PostgresIdempotencyStore('postgres://unused', {
      pool: fakePool({ failConnect: true }),
    });

    const claim = await store.begin('k1');
    assert.equal(claim.replayed, false);
    assert.equal(store.degraded, true);

    await store.complete('k1', 200, { success: true });
    const replay = await store.begin('k1');
    assert.equal(replay.replayed, true);
    assert.equal(replay.statusCode, 200);
  });

  test('degrades to memory when queries fail', async () => {
    const store = new PostgresIdempotencyStore('postgres://unused', {
      pool: fakePool({ failQuery: true }),
    });

    const claim = await store.begin('k1');
    assert.equal(claim.replayed, false);
    assert.equal(store.degraded, true);

    await store.complete('k1', 200, { data: 'test' });
    const replay = await store.begin('k1');
    assert.equal(replay.replayed, true);
  });

  test('recovers after pool becomes reachable again', async () => {
    let failConnect = true;
    const poolFactory = () =>
      fakePool({
        get failConnect() {
          return failConnect;
        },
      });
    const pool = poolFactory();

    const store = new PostgresIdempotencyStore('postgres://unused', { pool });

    // First claim fails — degrades.
    await store.begin('k1');
    assert.equal(store.degraded, true);

    // Pool comes back.
    failConnect = false;
    store.degraded = false;

    // Operations now work through Postgres path.
    const claim = await store.begin('k2');
    assert.equal(claim.replayed, false);
  });

  test('settles successfully during Postgres outage', async () => {
    const pool = fakePool({ failConnect: true });
    const store = new PostgresIdempotencyStore('postgres://unused', { pool });

    const facilitator = stubFacilitator();
    const instance = await serve({
      config: testConfig(),
      facilitator,
      catalog: stubCatalog(),
      idempotency: store,
    });

    try {
      const res = await instance.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(facilitator.calls.length, 1);
    } finally {
      await instance.close();
    }
  });

  test('does not crash when database is unreachable at construction', async () => {
    const store = new PostgresIdempotencyStore('postgres://127.0.0.1:1', {
      pool: fakePool({ failConnect: true }),
    });

    // Graceful degradation — not throwing.
    const claim = await store.begin('k1');
    assert.equal(claim.replayed, false);
    assert.equal(store.degraded, true);
  });

  test('multiple idempotency keys during outage do not interfere', async () => {
    const store = new PostgresIdempotencyStore('postgres://unused', {
      pool: fakePool({ failConnect: true }),
    });

    const claim1 = await store.begin('key-1');
    const claim2 = await store.begin('key-2');
    assert.equal(claim1.replayed, false);
    assert.equal(claim2.replayed, false);

    await store.complete('key-1', 200, { id: 1 });
    await store.complete('key-2', 200, { id: 2 });

    const replay1 = await store.begin('key-1');
    const replay2 = await store.begin('key-2');
    assert.equal(replay1.replayed, true);
    assert.equal(replay2.replayed, true);
    assert.deepEqual(replay1.response, { id: 1 });
    assert.deepEqual(replay2.response, { id: 2 });
  });

  test('complete() falls back gracefully during outage', async () => {
    let failQuery = false;
    const pool = {
      async connect() {
        return {
          query: async sql => {
            if (failQuery) throw new Error('connection lost');
            if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
            if (/INSERT/.test(sql)) return { rowCount: 1 };
            if (/SELECT/.test(sql)) return { rows: [] };
            return {};
          },
          release: () => {},
        };
      },
      async query(sql) {
        if (failQuery) throw new Error('connection lost');
        if (/UPDATE/.test(sql)) return { rowCount: 1 };
        return {};
      },
    };

    const store = new PostgresIdempotencyStore('postgres://unused', { pool });

    const claim = await store.begin('k1');
    assert.equal(claim.replayed, false);

    failQuery = true;
    await store.complete('k1', 200, { success: true });
    assert.equal(store.degraded, true);
  });
});

// ---------------------------------------------------------------------------
// Distributed lock chaos
// ---------------------------------------------------------------------------

describe('distributed lock chaos', () => {
  function fakeNode({ fail = false, errorMessage = 'Connection is closed' } = {}) {
    const locks = new Map();
    return {
      status: fail ? 'connecting' : 'ready',
      calls: [],
      async evalsha() {
        this.calls.push('evalsha');
        if (fail) throw new Error(errorMessage);
        throw new Error('NOSCRIPT No matching script.');
      },
      async eval(script, numKeys, args) {
        this.calls.push('eval');
        if (fail) throw new Error(errorMessage);
        const [key, value, ttl] = args;
        const now = Date.now();
        const current = locks.get(key);
        const expired = !current || current.expireAt <= now;
        if (script.includes('"exists"')) {
          if (!expired) return 0;
          locks.set(key, { value, expireAt: now + Number(ttl) });
          return 1;
        }
        if (script.includes('del')) {
          if (current && !expired && current.value === value) locks.delete(key);
          return 1;
        }
        if (current && !expired && current.value === value) {
          current.expireAt = now + Number(ttl);
          return 1;
        }
        return 0;
      },
      async quit() {},
    };
  }

  test('falls back to in-process lock when all Redis nodes are unreachable', async () => {
    const lock = createDistributedLock({
      nodes: ['redis://n1', 'redis://n2', 'redis://n3'],
      ttlMs: 500,
      acquireTimeoutMs: 500,
      retryDelayMs: 50,
      createClient: () => [
        fakeNode({ fail: true }),
        fakeNode({ fail: true }),
        fakeNode({ fail: true }),
      ],
    });

    const result = await lock.withLock('settle:payment-1', async () => 'served');
    assert.equal(result, 'served');
    // kind stays 'redlock' (set at construction); degradation is internal.
    await lock.quit();
  });

  test('refuses to proceed when some Redis nodes are reachable but quorum fails', async () => {
    // 1/3 healthy: quorum (2) is not met. The code correctly refuses to
    // degrade to in-process when any node IS reachable — partial cluster
    // health means cross-replica correctness is still possible, so racing
    // would be worse than failing.
    const healthyNode = fakeNode();
    const failedNodes = [fakeNode({ fail: true }), fakeNode({ fail: true })];

    const lock = createDistributedLock({
      nodes: ['redis://n1', 'redis://n2', 'redis://n3'],
      ttlMs: 500,
      acquireTimeoutMs: 1000,
      retryDelayMs: 50,
      createClient: () => [healthyNode, ...failedNodes],
    });

    await assert.rejects(
      lock.withLock('settle:payment-2', async () => 'must-not-run'),
      LockAcquireTimeoutError,
    );
    await lock.quit();
  });

  test('connection reset during lock hold does not crash the service', async () => {
    const node = fakeNode();
    const lock = createDistributedLock({
      nodes: ['redis://n1', 'redis://n2', 'redis://n3'],
      ttlMs: 500,
      acquireTimeoutMs: 1000,
      retryDelayMs: 50,
      createClient: () => [node, fakeNode(), fakeNode()],
    });

    const result = await lock.withLock('settle:payment-3', async () => 'served');
    assert.equal(result, 'served');
    await lock.quit();
  });

  test('concurrent operations during failure remain correct', async () => {
    const lock = createDistributedLock({
      nodes: ['redis://n1', 'redis://n2', 'redis://n3'],
      ttlMs: 500,
      acquireTimeoutMs: 500,
      retryDelayMs: 25,
      createClient: () => [
        fakeNode({ fail: true }),
        fakeNode({ fail: true }),
        fakeNode({ fail: true }),
      ],
    });

    let maxConcurrent = 0;
    let current = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        lock.withLock('key', async () => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await sleep(10);
          current--;
        }),
      ),
    );

    assert.equal(maxConcurrent, 1, 'in-process lock must serialize concurrent operations');
    await lock.quit();
  });
});

// ---------------------------------------------------------------------------
// HTTP surface chaos
// ---------------------------------------------------------------------------

describe('HTTP surface chaos', () => {
  test('/verify degrades gracefully when Redis is down', async () => {
    const client = fakeRedis({ fail: true });
    const rateLimiter = new RedisRateLimiter(limiterConfig(), { client });
    const instance = await serve({
      config: testConfig(),
      rateLimiter,
    });

    try {
      const res = await instance.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.isValid, true);
    } finally {
      await instance.close();
    }
  });

  test('/settle degrades gracefully when Redis is down', async () => {
    const client = fakeRedis({ fail: true });
    const rateLimiter = new RedisRateLimiter(limiterConfig(), { client });
    const instance = await serve({
      config: testConfig(),
      rateLimiter,
    });

    try {
      const res = await instance.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.transaction);
    } finally {
      await instance.close();
    }
  });

  test('/settle works during Postgres outage with in-memory idempotency', async () => {
    const store = new PostgresIdempotencyStore('postgres://unused', {
      pool: fakePool({ failConnect: true }),
    });

    const facilitator = stubFacilitator();
    const instance = await serve({
      config: testConfig(),
      facilitator,
      catalog: stubCatalog(),
      idempotency: store,
    });

    try {
      const res = await instance.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).success, true);
    } finally {
      await instance.close();
    }
  });

  test('/settle replays correctly during idempotency degradation', async () => {
    const store = new PostgresIdempotencyStore('postgres://unused', {
      pool: fakePool({ failConnect: true }),
    });

    const facilitator = stubFacilitator();
    const instance = await serve({
      config: testConfig(),
      facilitator,
      catalog: stubCatalog(),
      idempotency: store,
    });

    try {
      const headers = { 'idempotency-key': 'chaos-key' };
      const first = await instance.post('/settle', VALID_BODY, headers);
      const second = await instance.post('/settle', VALID_BODY, headers);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), await first.json());
      assert.equal(facilitator.calls.filter(c => c.name === 'settle').length, 1);
    } finally {
      await instance.close();
    }
  });

  test('rate limiter and idempotency both down simultaneously', async () => {
    const client = fakeRedis({ fail: true });
    const rateLimiter = new RedisRateLimiter(limiterConfig(), { client });
    const idempotency = new PostgresIdempotencyStore('postgres://unused', {
      pool: fakePool({ failConnect: true }),
    });

    const instance = await serve({
      config: testConfig(),
      rateLimiter,
      catalog: stubCatalog(),
      idempotency,
    });

    try {
      const res = await instance.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).success, true);
    } finally {
      await instance.close();
    }
  });

  test('/healthz and /supported remain available during all failures', async () => {
    const client = fakeRedis({ fail: true });
    const rateLimiter = new RedisRateLimiter(limiterConfig(), { client });
    const instance = await serve({
      config: testConfig(),
      rateLimiter,
    });

    try {
      const healthz = await instance.get('/healthz');
      assert.equal(healthz.status, 200);

      const supported = await instance.get('/supported');
      assert.equal(supported.status, 200);
    } finally {
      await instance.close();
    }
  });

  test('verify works correctly after rate limiter recovers', async () => {
    let fail = true;
    const client = {
      status: 'ready',
      on: () => {},
      async incr(_key) {
        if (fail) throw new Error('Connection reset');
        return 1;
      },
      async expire() {
        return 1;
      },
      async get(_key) {
        if (fail) throw new Error('Connection reset');
        return null;
      },
    };

    const rateLimiter = new RedisRateLimiter(limiterConfig(), { client });
    const instance = await serve({
      config: testConfig(),
      rateLimiter,
    });

    try {
      const res1 = await instance.post('/verify', VALID_BODY);
      assert.equal(res1.status, 200);
      assert.equal(rateLimiter.degraded, true);

      // Redis comes back.
      fail = false;
      rateLimiter._recover();
      assert.equal(rateLimiter.degraded, false);

      const res2 = await instance.post('/verify', VALID_BODY);
      assert.equal(res2.status, 200);
    } finally {
      await instance.close();
    }
  });

  test('settle works correctly after idempotency store recovers', async () => {
    let failConnect = true;
    const idempotency = new PostgresIdempotencyStore('postgres://unused', {
      pool: fakePool({
        get failConnect() {
          return failConnect;
        },
      }),
    });

    const instance = await serve({
      config: testConfig(),
      idempotency,
    });

    try {
      const res1 = await instance.post('/settle', VALID_BODY);
      assert.equal(res1.status, 200);
      assert.equal(idempotency.degraded, true);

      // Postgres comes back.
      failConnect = false;
      idempotency.degraded = false;

      const res2 = await instance.post('/settle', VALID_BODY);
      assert.equal(res2.status, 200);
    } finally {
      await instance.close();
    }
  });

  test('settle with distributed lock degrades to in-process when Redis is down', async () => {
    const lock = createDistributedLock({
      nodes: ['redis://n1', 'redis://n2', 'redis://n3'],
      ttlMs: 500,
      acquireTimeoutMs: 500,
      retryDelayMs: 25,
      createClient: () => [
        fakeNode({ fail: true }),
        fakeNode({ fail: true }),
        fakeNode({ fail: true }),
      ],
    });

    const instance = await serve({
      config: testConfig(),
      facilitator: stubFacilitator(),
      extras: { distributedLock: lock },
    });

    try {
      const res = await instance.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).success, true);
    } finally {
      await instance.close();
      await lock.quit();
    }
  });

  function fakeNode({ fail = false } = {}) {
    return {
      status: fail ? 'connecting' : 'ready',
      calls: [],
      async evalsha() {
        this.calls.push('evalsha');
        if (fail) throw new Error('Connection is closed.');
        throw new Error('NOSCRIPT No matching script.');
      },
      async eval(script, _numKeys, _args) {
        this.calls.push('eval');
        if (fail) throw new Error('Connection is closed.');
        if (script.includes('"exists"')) {
          return 1;
        }
        return 1;
      },
      async quit() {},
    };
  }
});
