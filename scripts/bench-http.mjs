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
 */
import { parseArgs } from 'node:util';
import { createApp } from '../src/app.js';

const { values } = parseArgs({
  options: {
    duration: { type: 'string', default: '10' },
    concurrency: { type: 'string', default: '64' },
  },
});

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

async function bench(name, path, body) {
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

console.log(
  `benchmark: ${values.concurrency} concurrent connections, ${values.duration}s per path\n`,
);
await bench('GET /healthz', '/healthz');
await bench('POST /verify', '/verify', VALID_BODY);
await bench('GET /supported', '/supported');
