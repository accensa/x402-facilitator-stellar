/**
 * `createEnvelope` is idempotent by envelope id (#724).
 *
 * The envelope id is the caller's idempotency key. Before this fix a repeated
 * create — the normal retry after a timeout or network hiccup — overwrote the
 * pending record, silently discarding every co-signature gathered so far and
 * resetting the deadline. These tests pin the three outcomes that matter:
 * same transaction returns the existing snapshot untouched; a different
 * transaction is a conflict rather than a destructive overwrite; and every
 * returned object is a snapshot, so a caller cannot mutate stored state.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMultiSignerEngine } from '../src/multi-signer.js';

const XDR = 'AAAAAgAAAABkdXBsaWNhdGUgZW52ZWxvcGU=';

describe('createEnvelope idempotency (#724)', () => {
  test('a duplicate id with the same transaction returns the existing snapshot', () => {
    let t = 1_000;
    const engine = createMultiSignerEngine({ threshold: 2, now: () => t });

    const first = engine.createEnvelope({
      id: 'env-dup',
      transactionXdr: XDR,
      threshold: 2,
      requiredSigners: ['cosigner-a', 'cosigner-b'],
      expiresInMs: 50_000,
    });
    engine.addSignature('env-dup', { signer: 'cosigner-a', signature: 'sig-a' });

    t = 2_000;
    // The retry omits expiresInMs, exactly as a client replaying its original
    // request body might; it must still return the first envelope's deadline.
    const retry = engine.createEnvelope({
      id: 'env-dup',
      transactionXdr: XDR,
      threshold: 2,
      requiredSigners: ['cosigner-a', 'cosigner-b'],
    });

    assert.notEqual(retry, first, 'each call returns its own snapshot');
    assert.equal(retry.id, 'env-dup');
    assert.equal(retry.transactionXdr, XDR);
    assert.equal(retry.createdAt, 1_000);
    assert.equal(retry.expiresAt, 51_000, 'the retry must not reset the deadline');
    assert.equal(retry.collected, 1);
    assert.deepEqual(retry.signatures, [{ signer: 'cosigner-a', signature: 'sig-a' }]);
    assert.equal(engine.listPending().length, 1, 'no duplicate entry was created');
  });

  test('a retry preserves gathered signatures and the envelope can still complete', () => {
    const engine = createMultiSignerEngine({ threshold: 2 });
    engine.createEnvelope({
      id: 'env-progress',
      transactionXdr: XDR,
      threshold: 2,
      requiredSigners: ['cosigner-a', 'cosigner-b'],
    });
    engine.addSignature('env-progress', { signer: 'cosigner-a', signature: 'sig-a' });

    const retry = engine.createEnvelope({
      id: 'env-progress',
      transactionXdr: XDR,
      threshold: 2,
      requiredSigners: ['cosigner-a', 'cosigner-b'],
    });
    assert.equal(retry.collected, 1, 'the co-signature survived the retry');

    engine.addSignature('env-progress', { signer: 'cosigner-b', signature: 'sig-b' });
    assert.equal(engine.isComplete('env-progress'), true);

    const assembled = engine.assembleEnvelope('env-progress');
    assert.deepEqual(
      assembled.signatures.map(s => s.signer),
      ['cosigner-a', 'cosigner-b'],
    );
  });

  test('a duplicate id with a different transaction is a conflict and changes nothing', () => {
    const engine = createMultiSignerEngine({ threshold: 2 });
    engine.createEnvelope({ id: 'env-conflict', transactionXdr: XDR, threshold: 2 });
    engine.addSignature('env-conflict', { signer: 'cosigner-a', signature: 'sig-a' });

    assert.throws(
      () =>
        engine.createEnvelope({
          id: 'env-conflict',
          transactionXdr: 'AAAAAgAAAABkaWZmZXJlbnQgdHJhbnNhY3Rpb24=',
          threshold: 2,
        }),
      /conflict/,
    );

    const stored = engine.getEnvelope('env-conflict');
    assert.equal(stored.transactionXdr, XDR, 'the original transaction was not replaced');
    assert.equal(stored.collected, 1, 'the gathered signature was not discarded');
    assert.deepEqual(stored.signatures, [{ signer: 'cosigner-a', signature: 'sig-a' }]);
  });

  test('retrying a completed envelope returns its complete snapshot, not a fresh pending one', () => {
    const engine = createMultiSignerEngine({ threshold: 1 });
    engine.createEnvelope({ id: 'env-complete', transactionXdr: XDR, threshold: 1 });
    engine.addSignature('env-complete', { signer: 'cosigner-a', signature: 'sig-a' });
    assert.equal(engine.getEnvelope('env-complete').status, 'complete');

    const retry = engine.createEnvelope({ id: 'env-complete', transactionXdr: XDR, threshold: 1 });

    assert.equal(retry.status, 'complete');
    assert.equal(retry.complete, true);
    assert.equal(retry.collected, 1);
  });

  test('retrying an expired envelope does not revive it or extend its deadline', () => {
    let t = 1_000;
    const engine = createMultiSignerEngine({ threshold: 2, now: () => t });
    engine.createEnvelope({
      id: 'env-expired-retry',
      transactionXdr: XDR,
      threshold: 2,
      requiredSigners: ['cosigner-a', 'cosigner-b'],
      expiresInMs: 50,
    });
    engine.addSignature('env-expired-retry', { signer: 'cosigner-a', signature: 'sig-a' });

    t = 2_000;
    const retry = engine.createEnvelope({ id: 'env-expired-retry', transactionXdr: XDR });
    assert.equal(retry.expiresAt, 1_050, 'the retry must not reset the deadline');
    assert.throws(
      () =>
        engine.addSignature('env-expired-retry', {
          signer: 'cosigner-b',
          signature: 'sig-b',
        }),
      /expired/,
    );
  });

  test('returned snapshots are isolated from the stored envelope', () => {
    const engine = createMultiSignerEngine({ threshold: 2 });
    const first = engine.createEnvelope({
      id: 'env-isolation',
      transactionXdr: XDR,
      requiredSigners: ['cosigner-a', 'cosigner-b'],
    });

    // Mutating a returned snapshot must not reach the stored record.
    first.signatures.push({ signer: 'forged', signature: 'forged' });
    first.requiredSigners.push('forged');
    first.transactionXdr = 'mutated-after-return';

    const retry = engine.createEnvelope({
      id: 'env-isolation',
      transactionXdr: XDR,
      requiredSigners: ['cosigner-a', 'cosigner-b'],
    });

    assert.notEqual(retry, first);
    assert.equal(retry.transactionXdr, XDR);
    assert.deepEqual(retry.requiredSigners, ['cosigner-a', 'cosigner-b']);
    assert.deepEqual(retry.signatures, []);
    assert.equal(retry.collected, 0);
  });
});
