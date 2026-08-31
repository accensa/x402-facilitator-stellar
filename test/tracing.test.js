/**
 * Tracing bootstrap (#tracing).
 *
 * Covers the two properties the rest of the code relies on: tracing can be
 * disabled wholesale, and when enabled it starts exactly one SDK (idempotent)
 * that actually produces spans via the shared @opentelemetry/api tracer and
 * exports them over OTLP. A local mock OTLP/HTTP receiver stands in for Jaeger
 * or Honeycomb so the export path is exercised without a real backend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { trace } from '@opentelemetry/api';
import { initTracing, tracer } from '../src/tracing.js';

test('disabled when TRACING_ENABLED=false', () => {
  const sdk = initTracing({ TRACING_ENABLED: 'false' });
  assert.equal(sdk, null);
  // No SDK running means there is no active span to annotate.
  assert.equal(trace.getActiveSpan(), undefined);
});

test('starts a single idempotent SDK, emits and exports spans', async () => {
  // Mock OTLP/HTTP receiver: records that a trace was POSTed to it.
  let received = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/traces') {
      received += 1;
      res.statusCode = 200;
    } else {
      res.statusCode = 404;
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();

  const first = initTracing({
    TRACING_ENABLED: 'true',
    OTEL_SERVICE_NAME: 'test-facilitator',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
  });
  assert.ok(first, 'expected an initialized SDK');
  assert.equal(initTracing({ TRACING_ENABLED: 'true' }), first, 'must be idempotent');

  // The tracer the transport uses must yield usable spans carrying attributes.
  const attrs = await tracer.startActiveSpan('test.span', async span => {
    span.setAttribute('tenant.id', 'key_0');
    span.setAttribute('x402.transaction.id', 'tx-hash');
    const active = trace.getActiveSpan();
    assert.ok(active, 'span should be active within startActiveSpan');
    span.end();
    return {
      tenant: active?.attributes?.['tenant.id'],
      tx: active?.attributes?.['x402.transaction.id'],
    };
  });
  assert.equal(attrs.tenant, 'key_0');
  assert.equal(attrs.tx, 'tx-hash');

  await first.shutdown();
  assert.equal(received, 1, 'shutdown should have flushed the span to OTLP');

  await new Promise(resolve => server.close(resolve));
});
