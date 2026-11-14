import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { initTracing, tracedSchemeCall } from '../src/tracing.js';

describe('tracedSchemeCall span status on failed verification and settlement (#768)', () => {
  let server;
  let sdk;

  before(async () => {
    server = http.createServer((req, res) => {
      res.statusCode = req.method === 'POST' && req.url === '/v1/traces' ? 200 : 404;
      res.end();
    });
    await new Promise(resolve => server.listen(0, resolve));
    const { port } = server.address();
    sdk = initTracing({
      TRACING_ENABLED: 'true',
      OTEL_SERVICE_NAME: 'test-facilitator-failure-status',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    });
  });

  after(async () => {
    if (sdk) await sdk.shutdown();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('records SpanStatusCode.ERROR and error attributes when settlement returns success: false', async () => {
    let capturedSpan;
    const result = await tracedSchemeCall('settle', 'stellar:testnet', async () => {
      capturedSpan = trace.getActiveSpan();
      return {
        success: false,
        errorReason: 'tx_failed',
        errorMessage: 'Transaction simulation failed: host budget exceeded',
        transaction: 'tx_failed_hash_123',
      };
    });

    assert.equal(result.success, false);
    assert.ok(capturedSpan, 'expected an active span');
    assert.equal(capturedSpan.status.code, SpanStatusCode.ERROR);
    assert.equal(
      capturedSpan.status.message,
      'Transaction simulation failed: host budget exceeded',
    );
    assert.equal(capturedSpan.attributes['x402.network'], 'stellar:testnet');
    assert.equal(capturedSpan.attributes['x402.transaction.id'], 'tx_failed_hash_123');
    assert.equal(capturedSpan.attributes['x402.error.reason'], 'tx_failed');
    assert.equal(
      capturedSpan.attributes['x402.error.message'],
      'Transaction simulation failed: host budget exceeded',
    );
  });

  test('records SpanStatusCode.ERROR and error attributes when verification returns isValid: false', async () => {
    let capturedSpan;
    const result = await tracedSchemeCall('verify', 'stellar:testnet', async () => {
      capturedSpan = trace.getActiveSpan();
      return {
        isValid: false,
        invalidReason: 'insufficient_amount',
      };
    });

    assert.equal(result.isValid, false);
    assert.ok(capturedSpan, 'expected an active span');
    assert.equal(capturedSpan.status.code, SpanStatusCode.ERROR);
    assert.equal(capturedSpan.status.message, 'insufficient_amount');
    assert.equal(capturedSpan.attributes['x402.error.reason'], 'insufficient_amount');
    assert.equal(capturedSpan.attributes['x402.error.message'], 'insufficient_amount');
  });

  test('records SpanStatusCode.OK when verification and settlement succeed', async () => {
    let verifySpan;
    const verifyRes = await tracedSchemeCall('verify', 'stellar:testnet', async () => {
      verifySpan = trace.getActiveSpan();
      return { isValid: true };
    });
    assert.equal(verifyRes.isValid, true);
    assert.equal(verifySpan.status.code, SpanStatusCode.OK);
    assert.equal(verifySpan.attributes['x402.error.reason'], undefined);

    let settleSpan;
    const settleRes = await tracedSchemeCall('settle', 'stellar:testnet', async () => {
      settleSpan = trace.getActiveSpan();
      return { success: true, transaction: 'tx_ok_456' };
    });
    assert.equal(settleRes.success, true);
    assert.equal(settleSpan.status.code, SpanStatusCode.OK);
    assert.equal(settleSpan.attributes['x402.transaction.id'], 'tx_ok_456');
    assert.equal(settleSpan.attributes['x402.error.reason'], undefined);
  });
});
