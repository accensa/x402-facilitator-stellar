/**
 * Outbox remaining-attempts logging (#770).
 *
 * `row.attempts` counts the attempts recorded before the current failed one, so
 * the remaining budget after this failure is `maxAttempts - (attempts + 1)`,
 * clamped at zero. The log used to omit the current attempt and so overstated
 * the remaining count by one on every retry — and reported a negative number on
 * the final attempt.
 *
 * The outbox is an in-memory stub shaped like
 * `import('../src/outbox/store.js').OutboxStore`; logs are captured through the
 * worker's injected `log`, so the suite stays offline and deterministic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pollOutboxOnce } from '../src/outbox/worker.js';

const row = (attempts, eventId = 'evt_1') => ({
  id: 1,
  event_id: eventId,
  type: 'settlement.completed',
  payload: { transaction: 'tx_hash' },
  attempts,
});

function failingOutbox(rows) {
  return {
    claimBatch: async () => rows,
    markPublished: async () => {},
    markFailed: async () => {},
  };
}

async function logFor(attempts, maxAttempts) {
  const logs = [];
  await pollOutboxOnce({
    outbox: failingOutbox([row(attempts)]),
    publish: async () => {
      throw new Error('broker unreachable');
    },
    maxAttempts,
    log: msg => logs.push(msg),
  });
  assert.equal(logs.length, 1, 'one failure produces one publish-failed log line');
  return logs[0];
}

describe('outbox worker remaining-attempts logging (#770)', () => {
  test('a failure with attempts remaining reports the correct remaining count', async () => {
    // attempts: 2 means this is the third attempt; 10 - 3 = 7 left.
    const line = await logFor(2, 10);
    assert.match(
      line,
      /^\[Outbox\] publish failed for event evt_1 \(7 attempts left\): broker unreachable$/,
    );
  });

  test('the logged count accounts for the current failed attempt', async () => {
    // The same row under the old formula logged 10 - 2 = 8.
    const line = await logFor(2, 10);
    assert.ok(line.includes('(7 attempts left)'), 'must subtract the attempt that just failed');
    assert.ok(!line.includes('(8 attempts left)'), 'must not overstate the remaining budget');
  });

  test('the final failed attempt reports 0 attempts left', async () => {
    // attempts: 9 on a 10-attempt budget: this failure exhausts the row.
    const line = await logFor(9, 10);
    assert.match(
      line,
      /^\[Outbox\] publish failed for event evt_1 \(0 attempts left\): broker unreachable$/,
    );
  });

  test('an exhausted row never logs a negative remaining count', async () => {
    const line = await logFor(15, 10);
    assert.ok(line.includes('(0 attempts left)'));
    assert.doesNotMatch(line, /-\d+ attempts left/);
  });

  test('the existing log message structure is preserved', async () => {
    const line = await logFor(0, 3);
    assert.equal(
      line,
      '[Outbox] publish failed for event evt_1 (2 attempts left): broker unreachable',
    );
  });
});
