/**
 * HTTP transport benchmark (#119).
 *
 * Boots the real Fastify app in-process with stubbed collaborators (no chain,
 * no keys, no network) and drives concurrent load against it, reporting
 * requests/second for the hot paths.
 *
 *   node scripts/bench-http.mjs [--duration 10] [--concurrency 64]
 *
 * Run against the pre-migration Express transport for comparison; the #119
 * acceptance target was >= 2x Express throughput at identical concurrency.
 *
 * RESOURCE-BUDGET MODE (#427). `--budget` replaces the timed throughput run
 * with a fixed request count and records what the run cost the process: peak
 * RSS, CPU core utilization and open sockets. It writes a markdown summary,
 * appends the run to a history file, and exits 1 when the budget is broken:
 *
 *   node scripts/bench-http.mjs --budget [--requests 1500] [--concurrency 32]
 *        [--report bench-results/resource-report.md]
 *        [--history bench-results/resource-history.jsonl]
 *
 * The budget: peak RSS <= 512 MiB, and wall-clock duration no more than 20%
 * over the median of the last 5 runs in the history file with the same
 * request count. The regression check compares runs on the same machine (the
 * history file), never against a number recorded elsewhere, so a slow CI
 * runner does not fail a build a fast laptop passed. With no history yet the
 * duration check is skipped and reported as such. The harness stubs the
 * facilitator and catalog, so no database pool is exercised; the socket count
 * is the connection measurement.
 */
import { parseArgs } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setInterval, clearInterval } from 'node:timers';
import { createApp } from '../src/app.js';

const MIB = 1024 * 1024;
export const MAX_RSS_BYTES = 512 * MIB;
export const MAX_DURATION_REGRESSION = 0.2;
const HISTORY_WINDOW = 5;

/** Open TCP sockets held by this process (clients and accepted connections). */
export function countOpenSockets() {
  return process.getActiveResourcesInfo().filter(r => r === 'TCPSocketWrap').length;
}

/**
 * Samples process resource use on an interval. Every source is injectable so
 * the arithmetic can be tested without depending on the real machine.
 *
 * CPU utilization is CPU-seconds (user + system) per wall-second, i.e. the
 * number of cores kept busy: 1.0 is one saturated core, and may exceed 1 with
 * worker threads or native work.
 */
export class ResourceSampler {
  constructor({
    intervalMs = 50,
    now = () => performance.now(),
    rss = () => process.memoryUsage().rss,
    cpu = () => process.cpuUsage(),
    sockets = countOpenSockets,
  } = {}) {
    Object.assign(this, { intervalMs, now, readRss: rss, readCpu: cpu, readSockets: sockets });
    this.timer = null;
  }

  start() {
    this.startedAt = this.now();
    this.startCpu = this.readCpu();
    this.lastAt = this.startedAt;
    this.lastCpuMicros = 0;
    this.peakRssBytes = 0;
    this.peakSockets = 0;
    this.peakCpuCores = 0;
    this.samples = 0;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
    return this;
  }

  sample() {
    const at = this.now();
    const cpu = this.readCpu();
    const cpuMicros = cpu.user - this.startCpu.user + (cpu.system - this.startCpu.system);
    const wallMs = at - this.lastAt;
    if (wallMs > 0) {
      const cores = (cpuMicros - this.lastCpuMicros) / 1000 / wallMs;
      this.peakCpuCores = Math.max(this.peakCpuCores, cores);
      this.lastAt = at;
      this.lastCpuMicros = cpuMicros;
    }
    this.peakRssBytes = Math.max(this.peakRssBytes, this.readRss());
    this.peakSockets = Math.max(this.peakSockets, this.readSockets());
    this.samples++;
  }

  stop() {
    clearInterval(this.timer);
    this.sample();
    const durationMs = this.now() - this.startedAt;
    const cpu = this.readCpu();
    const cpuMs = (cpu.user - this.startCpu.user + (cpu.system - this.startCpu.system)) / 1000;
    return {
      durationMs,
      peakRssBytes: this.peakRssBytes,
      avgCpuCores: durationMs > 0 ? cpuMs / durationMs : 0,
      peakCpuCores: this.peakCpuCores,
      peakSockets: this.peakSockets,
      samples: this.samples,
    };
  }
}

const median = xs => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** One entry per line; a corrupt line is skipped rather than losing the history. */
export function readHistory(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap(line => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

export function appendHistory(file, entry) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/**
 * Judges a run against the budget.
 *
 * @param {{durationMs: number, peakRssBytes: number, requests: number}} run
 * @param {object[]} history - earlier runs, oldest first
 * @returns {{ok: boolean, failures: string[], baselineDurationMs: number|null,
 *   durationChangePct: number|null}}
 */
export function checkBudget(
  run,
  history = [],
  { maxRssBytes = MAX_RSS_BYTES, maxRegression = MAX_DURATION_REGRESSION } = {},
) {
  const failures = [];
  if (run.peakRssBytes > maxRssBytes) {
    failures.push(
      `peak RSS ${(run.peakRssBytes / MIB).toFixed(1)} MiB exceeds the ${(maxRssBytes / MIB).toFixed(0)} MiB budget`,
    );
  }
  const comparable = history.filter(h => h.requests === run.requests).slice(-HISTORY_WINDOW);
  const baselineDurationMs = comparable.length ? median(comparable.map(h => h.durationMs)) : null;
  let durationChangePct = null;
  if (baselineDurationMs) {
    durationChangePct = (run.durationMs / baselineDurationMs - 1) * 100;
    if (run.durationMs > baselineDurationMs * (1 + maxRegression)) {
      failures.push(
        `duration ${run.durationMs.toFixed(0)} ms is ${durationChangePct.toFixed(1)}% over the ` +
          `${baselineDurationMs.toFixed(0)} ms baseline (limit ${(maxRegression * 100).toFixed(0)}%)`,
      );
    }
  }
  return { ok: failures.length === 0, failures, baselineDurationMs, durationChangePct };
}

/** Markdown summary of one run and its verdict. */
export function renderReport(run, verdict, { paths = [] } = {}) {
  const rows = [
    ['Requests', String(run.requests)],
    ['Concurrency', String(run.concurrency)],
    ['Duration', `${run.durationMs.toFixed(0)} ms`],
    ['Peak RSS', `${(run.peakRssBytes / MIB).toFixed(1)} MiB (budget ${MAX_RSS_BYTES / MIB} MiB)`],
    ['CPU (avg / peak cores)', `${run.avgCpuCores.toFixed(2)} / ${run.peakCpuCores.toFixed(2)}`],
    ['Peak open sockets', String(run.peakSockets)],
    [
      'Duration vs baseline',
      verdict.baselineDurationMs === null
        ? 'no history yet (check skipped)'
        : `${verdict.durationChangePct >= 0 ? '+' : ''}${verdict.durationChangePct.toFixed(1)}% ` +
          `(median of prior runs ${verdict.baselineDurationMs.toFixed(0)} ms, limit +${MAX_DURATION_REGRESSION * 100}%)`,
    ],
  ];
  const lines = [
    '# Resource budget report',
    '',
    `**Result: ${verdict.ok ? 'PASS' : 'FAIL'}**`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ];
  if (paths.length) {
    lines.push('', '| Path | Requests |', '| --- | --- |');
    lines.push(...paths.map(p => `| \`${p.name}\` | ${p.count} |`));
  }
  if (!verdict.ok) lines.push('', '## Budget failures', '', ...verdict.failures.map(f => `- ${f}`));
  return `${lines.join('\n')}\n`;
}

const config = {
  trustProxy: undefined,
  nodeEnv: 'test',
  cors: { allowedOrigins: [] },
  apiKeys: [],
  networks: ['stellar:testnet'],
};

const facilitator = {
  getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
  verify: async () => ({ isValid: true, payer: 'GABC' }),
  settle: async (_p, r) => ({ success: true, transaction: 'abc', network: r.network }),
};

const rateLimiter = {
  checkVerify: () => ({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Math.floor(Date.now() / 1000) + 60,
  }),
  checkSettle: () => ({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Math.floor(Date.now() / 1000) + 60,
  }),
  checkCatalog: () => ({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Math.floor(Date.now() / 1000) + 60,
  }),
  recordVerify: () => {},
  recordSettle: () => {},
  recordCatalog: () => {},
};

const catalog = {
  upsertResource: async r => r,
  listResources: async () => ({ items: [], total: 0 }),
};

const VALID_BODY = JSON.stringify({
  paymentPayload: {
    x402Version: 2,
    scheme: 'exact',
    network: 'stellar:testnet',
    payload: { transaction: 'AAAA' },
  },
  paymentRequirements: { scheme: 'exact', network: 'stellar:testnet' },
});

async function bench(values, name, path, body) {
  // The per-request access log would dominate console output at this rate;
  // mute it (and only it) while the benchmark runs.
  const realLog = console.log;
  console.log = () => {};
  const app = await createApp(config, facilitator, rateLimiter, catalog);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const durationMs = Number(values.duration) * 1000;
  const workers = Number(values.concurrency);
  const deadline = Date.now() + durationMs;
  let count = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (Date.now() < deadline) {
        const res = await fetch(
          `${base}${path}`,
          body
            ? { method: 'POST', headers: { 'content-type': 'application/json' }, body }
            : undefined,
        );
        await res.arrayBuffer();
        count++;
      }
    }),
  );

  await app.close();
  console.log = realLog;
  const rps = Math.round(count / (durationMs / 1000));
  realLog(`${name.padEnd(24)} ${String(rps).padStart(8)} req/s  (${count} requests)`);
}

/**
 * Drives `total` requests, spread over the three hot paths, against one app
 * instance while sampling resources.
 */
export async function runBudgetBenchmark({ requests = 1500, concurrency = 32 } = {}) {
  const realLog = console.log;
  // Mute the per-request access log and the audit channel, which writes to
  // stdout directly: at benchmark rates both would dominate the measurement.
  console.log = () => {};
  // Selective: under `node --test` the runner's own reporting shares stdout.
  const realWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.includes('"channel":"audit"')) return true;
    return realWrite.call(this, chunk, ...rest);
  };
  const app = await createApp(config, facilitator, rateLimiter, catalog);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const mix = [
    { name: 'GET /healthz', path: '/healthz' },
    { name: 'POST /verify', path: '/verify', body: VALID_BODY },
    { name: 'GET /supported', path: '/supported' },
  ].map(p => ({ ...p, count: 0 }));

  const sampler = new ResourceSampler().start();
  let issued = 0;
  let resources;
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (issued < requests) {
          const target = mix[issued++ % mix.length];
          const res = await fetch(
            `${base}${target.path}`,
            target.body
              ? {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: target.body,
                }
              : undefined,
          );
          await res.arrayBuffer();
          target.count++;
        }
      }),
    );
  } finally {
    resources = sampler.stop();
    await app.close();
    console.log = realLog;
    process.stdout.write = realWrite;
  }
  return {
    requests,
    concurrency,
    ...resources,
    paths: mix.map(({ name, count }) => ({ name, count })),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      duration: { type: 'string', default: '10' },
      concurrency: { type: 'string' },
      budget: { type: 'boolean', default: false },
      requests: { type: 'string', default: '1500' },
      report: { type: 'string', default: 'bench-results/resource-report.md' },
      history: { type: 'string', default: 'bench-results/resource-history.jsonl' },
    },
  });

  if (values.budget) {
    const run = await runBudgetBenchmark({
      requests: Number(values.requests),
      concurrency: Number(values.concurrency ?? 32),
    });
    const history = readHistory(values.history);
    const verdict = checkBudget(run, history);
    const report = renderReport(run, verdict, { paths: run.paths });
    mkdirSync(dirname(values.report), { recursive: true });
    writeFileSync(values.report, report);
    // Only a passing run becomes part of the baseline: a regression must not
    // drag the median toward itself and excuse the next one.
    if (verdict.ok) {
      const entry = { at: new Date().toISOString(), ...run };
      delete entry.paths;
      appendHistory(values.history, entry);
    }
    console.log(report);
    if (!verdict.ok) process.exitCode = 1;
    return;
  }

  values.concurrency ??= '64';
  console.log(
    `benchmark: ${values.concurrency} concurrent connections, ${values.duration}s per path\n`,
  );
  await bench(values, 'GET /healthz', '/healthz');
  await bench(values, 'POST /verify', '/verify', VALID_BODY);
  await bench(values, 'GET /supported', '/supported');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
