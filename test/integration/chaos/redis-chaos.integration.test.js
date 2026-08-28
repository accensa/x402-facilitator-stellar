/**
 * Redis chaos integration tests — real Redis through Toxiproxy.
 *
 * These tests connect to a real Redis instance via a Toxiproxy proxy and
 * exercise the RedisRateLimiter under real network fault conditions:
 * latency spikes, connection resets, and bandwidth throttling.
 *
 * Prerequisites:
 *   docker compose -f test/integration/chaos/docker-compose.toxiproxy.yml up -d
 *
 * Run:
 *   REDIS_URL=redis://127.0.0.1:6321 node --test test/integration/chaos/redis-chaos.integration.test.js
 */
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RedisRateLimiter } from '../../../src/redis-rate-limit.js';
import {
  reset,
  createProxy,
  addLatency,
  addConnectionReset,
  addBandwidthThrottle,
  addTimeout,
} from './toxiproxy-helper.mjs';

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
 * Skips the test suite if Toxiproxy is not reachable.
 */
async function toxiproxyAvailable() {
  try {
    const res = await fetch('http://127.0.0.1:8474/version');
    return res.ok;
  } catch {
    return false;
  }
}

const PROXY_NAME = 'chaos-redis';
const PROXY_LISTEN = '127.0.0.1:16379';
const REDIS_UPSTREAM = process.env.REDIS_UPSTREAM || 'redis:6379';

describe('Redis chaos through Toxiproxy', { skip: !(await toxiproxyAvailable()) }, () => {
  before(async () => {
    await reset();
    await createProxy(PROXY_NAME, PROXY_LISTEN, REDIS_UPSTREAM);
  });

  afterEach(async () => {
    await reset();
    // Re-create proxy for next test.
    await createProxy(PROXY_NAME, PROXY_LISTEN, REDIS_UPSTREAM);
  });

  after(async () => {
    await reset();
  });

  test('high latency (500ms) is tolerated', async () => {
    await addLatency(PROXY_NAME, 500);

    const limiter = new RedisRateLimiter(limiterConfig(), {
      redisUrl: `redis://127.0.0.1:16379`,
    });

    // Wait for Redis connection.
    await sleep(500);

    const start = Date.now();
    const check = await limiter.checkVerify({ ip: '10.0.0.1' });
    const elapsed = Date.now() - start;

    assert.equal(check.allowed, true);
    assert.ok(elapsed >= 400, `expected latency >= 400ms, got ${elapsed}ms`);
    assert.equal(limiter.degraded, false);

    await limiter.redis?.quit();
  });

  test('connection reset degrades and recovers', async () => {
    const limiter = new RedisRateLimiter(limiterConfig(), {
      redisUrl: `redis://127.0.0.1:16379`,
    });

    await sleep(500);

    // Verify healthy first.
    const healthy = await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(healthy.allowed, true);
    assert.equal(limiter.degraded, false);

    // Inject connection reset.
    await addConnectionReset(PROXY_NAME, 0);

    // Wait for the toxic to take effect on the next operation.
    await sleep(100);

    const degraded = await limiter.checkVerify({ ip: '10.0.0.2' });
    assert.equal(degraded.allowed, true);
    assert.equal(limiter.degraded, true);

    // Remove the toxic and let it recover.
    await reset();
    await createProxy(PROXY_NAME, PROXY_LISTEN, REDIS_UPSTREAM);
    await sleep(2000);

    limiter._recover();
    assert.equal(limiter.degraded, false);

    const recovered = await limiter.checkVerify({ ip: '10.0.0.3' });
    assert.equal(recovered.allowed, true);

    await limiter.redis?.quit();
  });

  test('bandwidth throttling does not prevent basic operations', async () => {
    await addBandwidthThrottle(PROXY_NAME, 1024); // 1KB/s — very slow

    const limiter = new RedisRateLimiter(limiterConfig(), {
      redisUrl: `redis://127.0.0.1:16379`,
    });

    await sleep(500);

    const check = await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(check.allowed, true);

    await limiter.redis?.quit();
  });

  test('connection timeout causes graceful degradation', async () => {
    await addTimeout(PROXY_NAME, 1); // 1ms timeout — always triggers

    const limiter = new RedisRateLimiter(limiterConfig(), {
      redisUrl: `redis://127.0.0.1:16379`,
    });

    await sleep(500);

    const check = await limiter.checkVerify({ ip: '10.0.0.1' });
    assert.equal(check.allowed, true);
    assert.equal(limiter.degraded, true);

    await limiter.redis?.quit();
  });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
