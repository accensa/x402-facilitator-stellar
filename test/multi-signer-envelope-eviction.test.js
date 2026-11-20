/**
 * Envelope eviction in the multi-signer engine (#765).
 *
 * `purgeExpired()` used to flip an expired envelope's status to `expired` while
 * leaving the record in the `pending` Map, so `pending.size` grew monotonically
 * for the process lifetime. These tests pin the fix: a past-deadline pending
 * envelope is physically deleted, counted once, and is no longer retrievable,
 * while live and completed envelopes keep working.
 *
 * `pending` is module-internal, so the Map's size is observed through the
 * engine's public surface: `getEnvelope()` (null once evicted) and
 * `listPending()` (its length is the number of tracked pending envelopes).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMultiSignerEngine } from '../src/multi-signer.js';
import { submitMultiSignerEnvelope } from '../src/facilitator.js';

/** Injected clock, so expiry is decided by a value, never by wall-clock timing. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: ms => {
      t += ms;
    },
  };
}

describe('multi-signer envelope eviction (#765)', () => {
  test('an expired pending envelope is removed from pending', () => {
    const c = clock();
    const engine = createMultiSignerEngine({ threshold: 2, now: c.now });
    engine.createEnvelope({
      id: 'expired-env',
      transactionXdr: 'AAAA expired',
      threshold: 2,
      expiresInMs: 50,
    });

    assert.notEqual(engine.getEnvelope('expired-env'), null);

    c.advance(100);

    assert.equal(engine.purgeExpired(), 1);
    assert.equal(engine.getEnvelope('expired-env'), null);
  });

  test('purgeExpired() returns the number of envelopes actually removed', () => {
    const c = clock();
    const engine = createMultiSignerEngine({ threshold: 2, now: c.now });
    for (const id of ['a', 'b']) {
      engine.createEnvelope({ id, transactionXdr: `AAAA ${id}`, threshold: 2, expiresInMs: 50 });
    }
    engine.createEnvelope({
      id: 'live',
      transactionXdr: 'AAAA live',
      threshold: 2,
      expiresInMs: 10_000,
    });

    c.advance(100);

    assert.equal(engine.purgeExpired(), 2);
    assert.equal(engine.getEnvelope('a'), null);
    assert.equal(engine.getEnvelope('b'), null);
    assert.notEqual(engine.getEnvelope('live'), null);
  });

  test('tracked pending envelopes shrink after cleanup', () => {
    const c = clock();
    const engine = createMultiSignerEngine({ threshold: 1, now: c.now });
    engine.createEnvelope({ id: 'short', transactionXdr: 'AAAA short', expiresInMs: 50 });
    engine.createEnvelope({ id: 'long', transactionXdr: 'AAAA long', expiresInMs: 10_000 });

    assert.equal(engine.listPending().length, 2);

    c.advance(100);

    // listPending() purges internally, so the count drops because the record
    // left the Map rather than because it merely changed status.
    assert.deepEqual(
      engine.listPending().map(e => e.id),
      ['long'],
    );
    assert.equal(engine.getEnvelope('short'), null);
  });

  test('repeated cleanup never counts an already-removed envelope again', () => {
    const c = clock();
    const engine = createMultiSignerEngine({ threshold: 1, now: c.now });
    engine.createEnvelope({ id: 'once', transactionXdr: 'AAAA once', expiresInMs: 50 });

    c.advance(100);

    assert.equal(engine.purgeExpired(), 1);
    assert.equal(engine.purgeExpired(), 0);
    assert.equal(engine.purgeExpired(), 0);
    assert.equal(engine.getEnvelope('once'), null);
  });

  test('non-expired pending envelopes remain available and usable', async () => {
    const c = clock();
    const engine = createMultiSignerEngine({ threshold: 2, now: c.now });
    engine.createEnvelope({
      id: 'live-env',
      transactionXdr: 'AAAA live',
      threshold: 2,
      requiredSigners: ['cosigner-a', 'cosigner-b'],
      expiresInMs: 10_000,
    });

    c.advance(100);
    engine.purgeExpired();

    const created = engine.getEnvelope('live-env');
    assert.equal(created.status, 'pending');
    assert.equal(engine.listPending().length, 1);

    engine.addSignature('live-env', { signer: 'cosigner-a', signature: 'sig-a' });
    engine.addSignature('live-env', { signer: 'cosigner-b', signature: 'sig-b' });
    assert.equal(engine.isComplete('live-env'), true);

    const assembled = engine.assembleEnvelope('live-env');
    assert.equal(assembled.transactionXdr, 'AAAA live');
    assert.deepEqual(
      assembled.signatures.map(s => s.signer),
      ['cosigner-a', 'cosigner-b'],
    );

    const submitted = [];
    const result = await submitMultiSignerEnvelope(engine, 'live-env', async env => {
      submitted.push(env);
      return { hash: 'live-hash' };
    });
    assert.equal(result.hash, 'live-hash');
    assert.equal(submitted.length, 1);
  });

  test('completed envelopes are not evicted by the expired-envelope cleanup', async () => {
    const c = clock();
    const engine = createMultiSignerEngine({ threshold: 1, now: c.now });
    engine.createEnvelope({
      id: 'done-env',
      transactionXdr: 'AAAA done',
      threshold: 1,
      expiresInMs: 50,
    });
    engine.addSignature('done-env', { signer: 'cosigner-a', signature: 'sig-a' });
    assert.equal(engine.getEnvelope('done-env').status, 'complete');

    const submitted = [];
    const result = await submitMultiSignerEnvelope(engine, 'done-env', async env => {
      submitted.push(env);
      return { hash: 'done-hash' };
    });
    assert.equal(result.hash, 'done-hash');
    assert.equal(submitted.length, 1);

    c.advance(100);

    // Cleanup targets pending envelopes only: the completed record stays put
    // (no retention window is invented for it) and is not counted as purged.
    assert.equal(engine.purgeExpired(), 0);
    assert.equal(engine.getEnvelope('done-env').status, 'complete');
  });

  test('evicted and unknown envelopes keep their distinct error messages', async () => {
    const c = clock();
    const engine = createMultiSignerEngine({ threshold: 1, now: c.now });
    engine.createEnvelope({ id: 'gone', transactionXdr: 'AAAA gone', expiresInMs: 50 });

    c.advance(100);
    engine.purgeExpired();

    // An evicted id still reports expiry, not "unknown".
    assert.throws(() => engine.assembleEnvelope('gone'), /multi-signer envelope "gone" expired/);
    assert.throws(
      () => engine.addSignature('gone', { signer: 'cosigner-a', signature: 'sig-a' }),
      /multi-signer envelope "gone" expired/,
    );
    await assert.rejects(
      engine.requestSignatures('gone', { endpoints: ['https://cosigner.example/sign'] }),
      /multi-signer envelope "gone" expired/,
    );
    await assert.rejects(
      submitMultiSignerEnvelope(engine, 'gone', async () => ({})),
      /multi-signer envelope "gone" expired/,
    );

    // A never-created id is still unknown.
    assert.throws(() => engine.assembleEnvelope('never'), /unknown multi-signer envelope "never"/);
    assert.throws(
      () => engine.addSignature('never', { signer: 'a', signature: 'sig' }),
      /unknown multi-signer envelope "never"/,
    );
    assert.equal(engine.isComplete('never'), false);
    assert.equal(engine.getEnvelope('never'), null);
  });

  test('reusing an evicted envelope id starts a fresh envelope', () => {
    const c = clock();
    const engine = createMultiSignerEngine({ threshold: 1, now: c.now });
    engine.createEnvelope({ id: 'reuse', transactionXdr: 'AAAA first', expiresInMs: 50 });

    c.advance(100);
    engine.purgeExpired();

    engine.createEnvelope({ id: 'reuse', transactionXdr: 'AAAA second', expiresInMs: 10_000 });
    const envelope = engine.getEnvelope('reuse');
    assert.equal(envelope.transactionXdr, 'AAAA second');
    assert.equal(envelope.status, 'pending');
    engine.addSignature('reuse', { signer: 'cosigner-a', signature: 'sig-a' });
    assert.equal(engine.assembleEnvelope('reuse').transactionXdr, 'AAAA second');
  });
});
