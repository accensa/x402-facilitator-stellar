/**
 * Tracing span status for scheme results (#768).
 *
 * `tracedSchemeCall` wraps an upstream verify/settle call. Those calls do not
 * always throw on failure: a rejected settlement resolves with
 * `{ success: false, errorReason }` and a rejected verification with
 * `{ isValid: false, invalidReason }`. Marking every resolving call OK hid all
 * of those from the trace, so this file pins the result-driven status, the
 * failure attributes and the fact that a transaction ID is still attached
 * whenever the result carries one.
 *
 * Spans are captured with an in-memory exporter registered through the
 * standard OpenTelemetry global provider, so the assertions read the real span
 * data an exporter would receive — status, status message and attributes —
 * without a network exporter or a running SDK.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { tracedSchemeCall } from '../src/tracing.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

after(async () => {
  await provider.shutdown();
});

/** Runs one scheme call and returns its result plus the single span it emitted. */
async function capture(op, fn) {
  exporter.reset();
  const result = await tracedSchemeCall(op, 'stellar:testnet', fn, { 'x402.scheme': 'exact' });
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1, 'exactly one scheme span is emitted');
  return { result, span: spans[0] };
}

describe('tracedSchemeCall span status follows the scheme result (#768)', () => {
  test('a failed settlement is an ERROR span carrying the failure reason', async () => {
    const settlement = {
      success: false,
      errorReason: 'insufficient_funds',
      errorMessage: 'payer balance too low',
      transaction: 'tx-failed-settle',
      network: 'stellar:testnet',
    };
    const { result, span } = await capture('settle', async () => settlement);

    assert.equal(result, settlement, 'the resolved result is passed through unchanged');
    assert.equal(span.name, 'facilitator.settle');
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, 'insufficient_funds');
    assert.equal(span.attributes['x402.error.reason'], 'insufficient_funds');
    assert.equal(span.attributes['x402.error.message'], 'payer balance too low');
    assert.equal(
      span.attributes['x402.transaction.id'],
      'tx-failed-settle',
      'transaction IDs are attached even on a failed settlement',
    );
  });

  test('a failed verification is an ERROR span carrying the failure reason', async () => {
    const verification = {
      isValid: false,
      invalidReason: 'invalid_exact_stellar_payload_signature',
      invalidMessage: 'signature does not match the payer',
    };
    const { result, span } = await capture('verify', async () => verification);

    assert.equal(result, verification);
    assert.equal(span.name, 'facilitator.verify');
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, 'invalid_exact_stellar_payload_signature');
    assert.equal(span.attributes['x402.error.reason'], 'invalid_exact_stellar_payload_signature');
    assert.equal(span.attributes['x402.error.message'], 'signature does not match the payer');
  });

  test('the reason is used as the message when the result carries no message', async () => {
    const { span } = await capture('settle', async () => ({
      success: false,
      errorReason: 'settlement_rejected',
    }));

    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, 'settlement_rejected');
    assert.equal(span.attributes['x402.error.reason'], 'settlement_rejected');
    assert.equal(span.attributes['x402.error.message'], 'settlement_rejected');
  });

  test('a successful settlement is an OK span with the transaction ID', async () => {
    const { span } = await capture('settle', async () => ({
      success: true,
      transaction: 'tx-settled',
      network: 'stellar:testnet',
    }));

    assert.equal(span.status.code, SpanStatusCode.OK);
    assert.equal(span.attributes['x402.transaction.id'], 'tx-settled');
    assert.equal(span.attributes['x402.error.reason'], undefined);
    assert.equal(span.attributes['x402.error.message'], undefined);
  });

  test('a successful verification is an OK span', async () => {
    const { span } = await capture('verify', async () => ({
      isValid: true,
      payer: 'G_PAYER',
    }));

    assert.equal(span.status.code, SpanStatusCode.OK);
    assert.equal(span.attributes['x402.error.reason'], undefined);
  });

  test('a thrown exception still produces an ERROR span and rejects', async () => {
    exporter.reset();
    await assert.rejects(
      () =>
        tracedSchemeCall('settle', 'stellar:testnet', async () => {
          throw new Error('rpc unreachable');
        }),
      /rpc unreachable/,
    );
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
    assert.equal(spans[0].status.message, 'rpc unreachable');
  });
});
