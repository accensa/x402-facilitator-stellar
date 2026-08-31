/**
 * End-to-end tracing of the HTTP surface (#tracing).
 *
 * Boots the real Fastify app (with stubbed collaborators) on a real port and
 * drives it with an instrumented undici client, against a mock OTLP/HTTP
 * collector. This proves the acceptance criteria that matter:
 *
 *   1. the SDK exports spans over OTLP;
 *   2. W3C Trace Context propagates across the HTTP boundary — the server span
 *      continues the client's trace and names the client span as its parent;
 *   3. spans carry the cross-service metadata — tenant.id and, on settle, the
 *      settlement transaction id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { context, propagation } from '@opentelemetry/api';
import { initTracing, tracer } from '../src/tracing.js';
import { resolveConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

function startCollector() {
  const spans = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/traces') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        try {
          const json = JSON.parse(body);
          for (const rs of json.resourceSpans ?? []) {
            for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []));
          }
        } catch {
          /* ignore malformed */
        }
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise(resolve => server.listen(0, () => resolve({ server, spans })));
}

const config = (() => {
  // A valid-format (but unpublished) ed25519 seed so the readiness checker,
  // which decodes the signer, succeeds without a real funded account.
  process.env.FACILITATOR_SECRET = StrKey.encodeEd25519SecretSeed(crypto.randomBytes(32));
  return resolveConfig(process.env);
})();

const facilitator = {
  async verify() {
    return { isValid: true };
  },
  async settle() {
    return { success: true, transaction: 'tx_deadbeef', network: 'stellar:testnet' };
  },
  getSupported() {
    return { schemes: {} };
  },
};

const rateLimiter = {
  async checkVerify() {
    return { allowed: true };
  },
  async recordVerify() {},
  async checkSettle() {
    return { allowed: true };
  },
  async recordSettle() {},
  async checkCatalog() {
    return { allowed: true };
  },
  async recordCatalog() {},
  async getUsage() {
    return {};
  },
};

const catalog = {
  async getResource() {
    return undefined;
  },
  async upsertResource() {},
  async listResources() {
    return { items: [], total: 0 };
  },
  async search() {
    return { resources: [], pagination: {} };
  },
};

test('W3C trace context propagates and spans carry metadata', { timeout: 30000 }, async () => {
  const { server: collector, spans } = await startCollector();
  const sdk = initTracing({
    TRACING_ENABLED: 'true',
    OTEL_SERVICE_NAME: 'test-facilitator',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
  });

  const app = createApp(config, facilitator, rateLimiter, catalog, null, {});
  await app.listen({ port: 0 });
  const { port } = app.server.address();
  const url = `http://127.0.0.1:${port}/settle`;

  const payload = JSON.stringify({
    paymentPayload: { transaction: 'xdr', signature: 'sig' },
    paymentRequirements: {
      scheme: 'exact',
      network: 'stellar:testnet',
      payTo: 'GABC',
      maxAmountRequired: '1',
      asset: 'USDC',
    },
  });

  // Drive the request inside an active client span and inject its W3C
  // traceparent into the request headers manually (Node's http client isn't
  // auto-instrumented here). The server's http instrumentation must extract it
  // and continue the trace — that is the cross-service propagation claim.
  const clientCtx = await tracer.startActiveSpan('test.client', async clientSpan => {
    const sc = clientSpan.spanContext();
    const headers = { 'content-type': 'application/json' };
    propagation.inject(context.active(), headers);
    const body = await postJson(url, payload, headers);
    assert.equal(body.transaction, 'tx_deadbeef');
    return { traceId: sc.traceId, spanId: sc.spanId };
  });

  await app.close();
  // Forces a flush so every span (client, server, scheme) reaches the collector.
  await sdk.shutdown();

  assert.ok(spans.length > 0, 'expected at least one exported span');

  // The manually created inbound span must continue the client's trace and
  // name the injected client span as its parent — W3C Trace Context
  // propagation across the HTTP boundary (inbound extraction).
  const inboundSpan = spans.find(
    s => s.name === 'HTTP POST /settle' && s.traceId === clientCtx.traceId,
  );
  assert.ok(inboundSpan, 'inbound span should continue the client trace');
  assert.equal(
    inboundSpan.parentSpanId,
    clientCtx.spanId,
    'inbound span should be parented by the injected client span',
  );

  // The scheme child span carries the settlement transaction id and tenant, and
  // is nested under the inbound span.
  const schemeSpan = spans.find(
    s => s.name === 'facilitator.settle' && s.traceId === clientCtx.traceId,
  );
  assert.ok(schemeSpan, 'expected a facilitator.settle span');
  assert.equal(schemeSpan.parentSpanId, inboundSpan.spanId, 'scheme span nests under inbound span');
  const attrs = Object.fromEntries(
    (schemeSpan.attributes ?? []).map(a => [a.key, a.value.stringValue ?? a.value.intValue]),
  );
  assert.equal(attrs['x402.transaction.id'], 'tx_deadbeef');
  assert.equal(attrs['tenant.id'], 'open');
  assert.equal(attrs['x402.network'], 'stellar:testnet');

  // The inbound span itself also carries the tenant metadata.
  const inboundAttrs = Object.fromEntries(
    (inboundSpan.attributes ?? []).map(a => [a.key, a.value.stringValue ?? a.value.intValue]),
  );
  assert.equal(inboundAttrs['tenant.id'], 'open');
  assert.equal(inboundAttrs['http.route'], '/settle');

  await new Promise(resolve => collector.close(resolve));
});

/** Minimal JSON POST over Node's http client. */
function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
