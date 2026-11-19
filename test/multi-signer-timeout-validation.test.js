/**
 * Co-signer timeout validation (#713).
 *
 * requestTimeoutMs is handed straight to setTimeout(() => controller.abort()).
 * A zero, negative, fractional or non-numeric value aborts every co-signer
 * request immediately (or never), so the engine reports that all co-signers
 * failed with nothing pointing at the configuration. Invalid values are
 * rejected at creation time with the same style as the threshold check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiSignerEngine, DEFAULT_COSIGNER_TIMEOUT_MS } from '../src/multi-signer.js';

test('the default co-signer timeout is valid', () => {
  assert.doesNotThrow(() => createMultiSignerEngine());
  const engine = createMultiSignerEngine({ requestTimeoutMs: DEFAULT_COSIGNER_TIMEOUT_MS });
  assert.equal(typeof engine.requestSignatures, 'function');
});

test('positive integer timeouts are accepted', () => {
  for (const requestTimeoutMs of [1, 250, 5_000, 120_000]) {
    assert.doesNotThrow(
      () => createMultiSignerEngine({ requestTimeoutMs }),
      `expected ${requestTimeoutMs} to be accepted`,
    );
  }
});

test('zero and negative timeouts are rejected at construction', () => {
  for (const requestTimeoutMs of [0, -1, -5_000, Number.MIN_SAFE_INTEGER]) {
    assert.throws(
      () => createMultiSignerEngine({ requestTimeoutMs }),
      /multi-signer requestTimeoutMs must be a positive integer/,
      `expected ${requestTimeoutMs} to be rejected`,
    );
  }
});

test('non-integer and non-numeric timeouts are rejected at construction', () => {
  const invalid = [1.5, 0.1, Number.NaN, Infinity, -Infinity, '5000', null, {}, [], true];
  for (const requestTimeoutMs of invalid) {
    assert.throws(
      () => createMultiSignerEngine({ requestTimeoutMs }),
      /multi-signer requestTimeoutMs must be a positive integer/,
      `expected ${String(requestTimeoutMs)} to be rejected`,
    );
  }
});

test('the error message names the offending value', () => {
  assert.throws(() => createMultiSignerEngine({ requestTimeoutMs: 0 }), /got "0"/);
  assert.throws(() => createMultiSignerEngine({ requestTimeoutMs: '250' }), /got "250"/);
});

test('an invalid timeout fails before any envelope state exists', () => {
  assert.throws(() => createMultiSignerEngine({ requestTimeoutMs: -1 }));
  // A valid engine still opens envelopes normally.
  const engine = createMultiSignerEngine({ threshold: 1, requestTimeoutMs: 1_000 });
  const envelope = engine.createEnvelope({
    id: 'env-timeout-valid',
    transactionXdr: 'AAAA valid timeout',
    threshold: 1,
    requiredSigners: ['cosigner-a'],
  });
  assert.equal(envelope.status, 'pending');
});

test('a valid timeout still drives co-signer requests', async () => {
  const engine = createMultiSignerEngine({
    threshold: 1,
    requestTimeoutMs: 250,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ signer: 'cosigner-a', signature: 'sig-a' }),
    }),
  });
  engine.createEnvelope({
    id: 'env-timeout-request',
    transactionXdr: 'AAAA request',
    threshold: 1,
    requiredSigners: ['cosigner-a'],
  });

  const results = await engine.requestSignatures('env-timeout-request', {
    endpoints: ['https://cosigner.example/sign'],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].signer, 'cosigner-a');
  assert.equal(engine.isComplete('env-timeout-request'), true);
});
