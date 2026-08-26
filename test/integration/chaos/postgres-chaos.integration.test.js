/**
 * Postgres chaos integration tests — real Postgres through Toxiproxy.
 *
 * These tests connect to a real Postgres instance via a Toxiproxy proxy and
 * exercise the PostgresIdempotencyStore under real network fault conditions:
 * latency spikes, connection resets, and bandwidth throttling.
 *
 * Prerequisites:
 *   docker compose -f test/integration/chaos/docker-compose.toxiproxy.yml up -d
 *
 * Run:
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/x402_facilitator \
 *     node --test test/integration/chaos/postgres-chaos.integration.test.js
 */
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresIdempotencyStore } from '../../../src/idempotency.js';
import {
  reset,
  createProxy,
  addLatency,
  addConnectionReset,
  addBandwidthThrottle,
  addTimeout,
} from './toxiproxy-helper.mjs';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/x402_facilitator';
const PROXY_NAME = 'chaos-postgres';
const PROXY_LISTEN = '127.0.0.1:15432';
const PG_UPSTREAM = process.env.PG_UPSTREAM || 'db:5432';

async function toxiproxyAvailable() {
  try {
    const res = await fetch('http://127.0.0.1:8474/version');
    return res.ok;
  } catch {
    return false;
  }
}

const RESPONSE = { success: true, transaction: 'tx-chaos-test', network: 'stellar:testnet' };

describe('Postgres chaos through Toxiproxy', { skip: !(await toxiproxyAvailable()) }, () => {
  before(async () => {
    await reset();
    await createProxy(PROXY_NAME, PROXY_LISTEN, PG_UPSTREAM);
  });

  afterEach(async () => {
    await reset();
    await createProxy(PROXY_NAME, PROXY_LISTEN, PG_UPSTREAM);
  });

  after(async () => {
    await reset();
  });

  test('high latency on Postgres is tolerated', async () => {
    await addLatency(PROXY_NAME, 500);

    const proxyUrl = DATABASE_URL.replace(/localhost|127\.0\.0\.1/, '127.0.0.1').replace(
      /:\d+\//,
      ':15432/',
    );
    const store = new PostgresIdempotencyStore(proxyUrl, { lockTimeoutMs: 5000 });

    // Wait for pool to be ready.
    await sleep(1000);

    const start = Date.now();
    const claim = await store.begin('latency-test');
    const elapsed = Date.now() - start;

    assert.equal(claim.replayed, false);
    assert.ok(elapsed >= 400, `expected latency >= 400ms, got ${elapsed}ms`);

    await store.complete('latency-test', 200, RESPONSE);
    const replay = await store.begin('latency-test');
    assert.equal(replay.replayed, true);
  });

  test('connection reset degrades to memory', async () => {
    const proxyUrl = DATABASE_URL.replace(/localhost|127\.0\.0\.1/, '127.0.0.1').replace(
      /:\d+\//,
      ':15432/',
    );
    const store = new PostgresIdempotencyStore(proxyUrl, { lockTimeoutMs: 5000 });

    await sleep(1000);

    // Verify healthy first.
    const healthy = await store.begin('reset-test-1');
    assert.equal(healthy.replayed, false);
    assert.equal(store.degraded, false);

    await store.complete('reset-test-1', 200, RESPONSE);

    // Inject connection reset.
    await addConnectionReset(PROXY_NAME, 0);
    await sleep(200);

    const degraded = await store.begin('reset-test-2');
    assert.equal(degraded.replayed, false);
    assert.equal(store.degraded, true);

    // Verify memory fallback works.
    await store.complete('reset-test-2', 200, RESPONSE);
    const replay = await store.begin('reset-test-2');
    assert.equal(replay.replayed, true);
  });

  test('bandwidth throttling does not prevent basic operations', async () => {
    await addBandwidthThrottle(PROXY_NAME, 512); // 512 bytes/s

    const proxyUrl = DATABASE_URL.replace(/localhost|127\.0\.0\.1/, '127.0.0.1').replace(
      /:\d+\//,
      ':15432/',
    );
    const store = new PostgresIdempotencyStore(proxyUrl, { lockTimeoutMs: 5000 });

    await sleep(1000);

    const claim = await store.begin('bw-test');
    assert.equal(claim.replayed, false);

    await store.complete('bw-test', 200, RESPONSE);
    const replay = await store.begin('bw-test');
    assert.equal(replay.replayed, true);
  });

  test('connection timeout causes graceful degradation', async () => {
    await addTimeout(PROXY_NAME, 1); // 1ms — always triggers

    const proxyUrl = DATABASE_URL.replace(/localhost|127\.0\.0\.1/, '127.0.0.1').replace(
      /:\d+\//,
      ':15432/',
    );
    const store = new PostgresIdempotencyStore(proxyUrl, { lockTimeoutMs: 5000 });

    await sleep(1000);

    const claim = await store.begin('timeout-test');
    assert.equal(claim.replayed, false);
    assert.equal(store.degraded, true);

    // Memory fallback works.
    await store.complete('timeout-test', 200, RESPONSE);
    const replay = await store.begin('timeout-test');
    assert.equal(replay.replayed, true);
  });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
