import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMetrics, signerMetrics } from '../src/metrics.js';
import { createApp, renderFullMetrics } from '../src/app.js';
import { stubFacilitator, stubRateLimiter, stubCatalog, testConfig } from './helpers/app.js';
import { MemorySettlementStore } from '../src/store/memory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function metricNames(text) {
  return new Set(
    text
      .split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('{')[0].split(' ')[0]),
  );
}

test('dedicated metrics listener renders the same full exposition as the app (#492, src/server.js:362)', async () => {
  const registry = createMetrics();
  registry.incRequests({
    route: '/verify',
    network: 'stellar:testnet',
    outcome: 'ok',
    reason: 'none',
  });
  signerMetrics.recordSelection('stellar:testnet', 'GTESTSIGNER492');

  const full = renderFullMetrics(registry);
  const names = metricNames(full);
  assert.ok(names.has('x402_requests_total'), 'registry series missing');
  assert.ok(names.has('x402_signer_selected_total'), 'signer series missing from shared renderer');

  // The app route goes through the same single function: boot the real app
  // and compare the metric-name sets of the two surfaces.
  const config = { ...testConfig(), requestTimeoutMs: 1000 };
  const app = await createApp(config, stubFacilitator(), stubRateLimiter(), stubCatalog(), null, {
    metrics: registry,
    settlementStore: new MemorySettlementStore(),
    serveMetrics: true,
  });
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(metricNames(res.body), names);
  await app.close();
});

test('both /metrics surfaces share one renderer (#492)', () => {
  const serverSrc = readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  const appSrc = readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  assert.match(appSrc, /export function renderFullMetrics/, 'shared renderer must live in app.js');
  assert.match(serverSrc, /renderFullMetrics/, 'dedicated listener must call the shared renderer');
  assert.ok(
    !serverSrc.match(/res\.end\(metrics\.render\(\)\)/),
    'bare metrics.render() must not remain',
  );
});
