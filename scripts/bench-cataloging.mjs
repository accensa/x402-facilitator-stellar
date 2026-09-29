#!/usr/bin/env node
/**
 * Benchmark: the /settle hot path with catalogable payment bodies.
 *
 * What is measured and why
 * ------------------------
 * Every successful /settle on a catalogable body runs processCataloging, which
 * until #368 serialized the outcome object through
 * `Buffer.from(JSON.stringify({ bazaar: outcome })).toString('base64')` even
 * when the caller never reads the EXTENSION-RESPONSES header. That is two
 * allocations (the JSON string, the Buffer copy) plus a base64 expansion
 * (4/3x) per settled payment, on the request path, for a header most callers
 * ignore.
 *
 * The fix makes the header encoding lazy: the header value is computed only if
 * Fastify actually serializes the headers — i.e. only when a caller (or a
 * proxy in front of it) asked to see it. The measured quantities:
 *
 *   - ops          settled payments per second through the real HTTP listener
 *   - p50/p95/p99  per-request latency
 *   - rss          resident set size after the run (allocation pressure proxy)
 *   - gcCount      major GC events observed during the run
 *
 * GC events are counted with the builtin v8 sampler (no --expose-gc needed),
 * so the numbers are reproducible in CI with plain `node`.
 *
 * Usage:
 *
 *   node scripts/bench-cataloging.mjs [--duration-ms N] [--warmup-ms N] [--json]
 *
 * Run it against the parent commit and the optimization commit with the same
 * flags and compare — the numbers below in the PR description were produced
 * exactly this way on the same machine, back to back.
 */

/**
 * Minimal argv reader — flags only, no values needed beyond durations.
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numFlag(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const raw = Number(process.argv[idx + 1]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const DURATION_MS = numFlag('duration-ms', 5000);
const WARMUP_MS = numFlag('warmup-ms', 1500);
const AS_JSON = process.argv.includes('--json');

/** Node's perf_hooks marks GC stop-the-world events with this detail entry. */
const GC_ENTRY_KIND = 'GC';
/** v8 GC detail keys marking a major (full mark-compact) collection. */
const MAJOR_GC_TYPES = new Set([2, 4, 7]); // kGCTypeMarkSweepCompact, incremental, incremental marking

import assert from 'node:assert/strict';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { stubRateLimiter } from '../test/helpers/rate-limiter.js';

// ---------------------------------------------------------------------------
// Collaborators: stubbed exactly like the HTTP benchmark (scripts/bench-http.mjs)
// so the only difference between the two runs is the change under test.
// ---------------------------------------------------------------------------

/** Facilitator returning a fixed successful settlement, recording calls. */
function stubFacilitator() {
  return {
    getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
    verify: async () => ({ isValid: true }),
    settle: async payload => ({
      success: true,
      transaction: 'bench-tx',
      network: payload?.payload?.network ?? 'stellar:testnet',
    }),
  };
}

/** Catalog recording writes without any I/O. */
function stubCatalog() {
  const stored = [];
  return {
    stored,
    upsertResource: async (resource, source) => {
      stored.push({ resource, source });
      return { ...resource, source };
    },
    listResources: async () => ({ items: [], total: 0 }),
  };
}

/** Config shape createApp expects; logging silenced so I/O cost stays out of the numbers. */
function testConfig() {
  return {
    trustProxy: undefined,
    nodeEnv: 'development',
    cors: { allowedOrigins: [] },
    apiKeys: [],
    networks: ['stellar:testnet'],
    logLevel: 'silent',
  };
}

/** Sink that swallows every log line the same way createRequestLog('silent') does. */
const silentAudit = () => {};

/** A request logger that does nothing: log I/O stays out of the measurements. */
const silentLogger = { begin: () => ({}), finish: () => {} };

// ---------------------------------------------------------------------------
// Request body: catalogable, so processCataloging runs its full happy path.
// ---------------------------------------------------------------------------

const CATALOGABLE_BODY = {
  paymentPayload: {
    x402Version: 2,
    scheme: 'exact',
    network: 'stellar:testnet',
    resource: { url: 'http://bench.ex/1', serviceName: 'bench', description: 'bench' },
    extensions: {
      bazaar: {
        info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
        schema: { type: 'object' },
        routeTemplate: '/1',
      },
    },
  },
  paymentRequirements: {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    maxAmountRequired: '1000',
    payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
  },
};

/** Each request carries a distinct tx so settle is a fresh settlement, not a replay. */
let txCounter = 0;
function nextBody() {
  txCounter += 1;
  return {
    ...CATALOGABLE_BODY,
    paymentPayload: {
      ...CATALOGABLE_BODY.paymentPayload,
      payload: { transaction: `tx-${txCounter}` },
    },
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

let gcMajorCount = 0;
/** Counts major GC stop-the-world events via the builtin performance observer. */
function observeGc() {
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== GC_ENTRY_KIND) continue;
      // v8 reports the GC type on `detail.kind` for node:gcs entries.
      const kind = entry.detail?.kind;
      if (MAJOR_GC_TYPES.has(kind)) gcMajorCount += 1;
    }
  });
  observer.observe({ entryTypes: ['gc'], buffered: true });
  return observer;
}

/** Percentile over a sorted array of samples. */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Drives sequential POST /settle requests for `durationMs`, returning ops and
 * latency samples. Sequential on purpose: this measures per-request CPU cost
 * (the thing the lazy encoding changes), not concurrency headroom.
 */
async function runPhase(app, base, durationMs, sampleLatencies) {
  const deadline = performance.now() + durationMs;
  let ops = 0;
  while (performance.now() < deadline) {
    const started = performance.now();
    const res = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nextBody()),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    if (sampleLatencies) sampleLatencies.push(performance.now() - started);
    ops += 1;
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const gcObserver = observeGc();
const app = await createApp(
  testConfig(),
  stubFacilitator(),
  stubRateLimiter(),
  stubCatalog(),
  undefined,
  { audit: silentAudit, logger: silentLogger },
);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

try {
  // Warmup: JIT, sockets, and Fastify's route compilation settle down here.
  await runPhase(app, base, WARMUP_MS, null);

  const latencies = [];
  const rssBefore = process.memoryUsage().rss;
  const ops = await runPhase(app, base, DURATION_MS, latencies);
  const rssAfter = process.memoryUsage().rss;

  latencies.sort((a, b) => a - b);
  const seconds = DURATION_MS / 1000;
  const result = {
    durationMs: DURATION_MS,
    ops,
    opsPerSecond: +(ops / seconds).toFixed(1),
    p50Ms: +percentile(latencies, 50).toFixed(2),
    p95Ms: +percentile(latencies, 95).toFixed(2),
    p99Ms: +percentile(latencies, 99).toFixed(2),
    rssDeltaMb: +((rssAfter - rssBefore) / 1024 / 1024).toFixed(2),
    rssAfterMb: +(rssAfter / 1024 / 1024).toFixed(2),
    gcMajorCount,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result));
  } else {
    console.log('cataloging hot-path benchmark (POST /settle, catalogable body, sequential)');
    console.log(`  duration        ${result.durationMs}ms`);
    console.log(`  ops             ${result.ops}`);
    console.log(`  ops/sec         ${result.opsPerSecond}`);
    console.log(`  p50 / p95 / p99 ${result.p50Ms} / ${result.p95Ms} / ${result.p99Ms} ms`);
    console.log(`  rss after       ${result.rssAfterMb}MB (delta ${result.rssDeltaMb}MB)`);
    console.log(`  major GCs       ${result.gcMajorCount}`);
  }
} finally {
  await app.close();
  gcObserver.disconnect();
}
