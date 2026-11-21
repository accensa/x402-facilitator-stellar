/**
 * Manual DLQ replay must not consume the automated retry budget (#716).
 *
 * `attemptRedelivery` is shared by the background poll loop and the operator
 * "replay now" action. Only the automated path may call `markRetryFailed`,
 * which increments `dlq_attempts`, advances `next_retry_at` and eventually
 * flips a message to `exhausted`. A failing manual replay is an out-of-band
 * probe and must leave all of that untouched, so an operator cannot exhaust a
 * message merely by retrying it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { attemptRedelivery, pollDlqOnce } from '../src/dlq/worker.js';

const MAX_DLQ_ATTEMPTS = 5;
const FIXED_NEXT_RETRY = '2026-01-01T00:00:00.000Z';
const RETRY_OPTIONS = { maxDlqAttempts: MAX_DLQ_ATTEMPTS, baseBackoffMs: 30_000 };

function makeRow(overrides = {}) {
  return {
    id: 7,
    message_id: 'msg-7',
    payload: { event: 'settled' },
    status: 'pending',
    dlq_attempts: MAX_DLQ_ATTEMPTS - 1,
    next_retry_at: FIXED_NEXT_RETRY,
    ...overrides,
  };
}

/**
 * In-memory stand-in for DeadLetterStore. It applies the same state
 * transitions the real store does, so an assertion on `state` is a meaningful
 * check that the worker did (or did not) consume the retry budget.
 */
function makeStore(row) {
  const state = { ...row };
  const calls = { markResolved: [], markRetryFailed: [] };
  return {
    state,
    calls,
    claimDue: async () => [{ ...state }],
    get: async () => ({ ...state }),
    markResolved: async id => {
      calls.markResolved.push(id);
      state.status = 'resolved';
    },
    markRetryFailed: async (id, error, retryOptions) => {
      calls.markRetryFailed.push({ id, error, retryOptions });
      state.dlq_attempts += 1;
      state.error = error;
      state.status =
        state.dlq_attempts >= (retryOptions?.maxDlqAttempts ?? MAX_DLQ_ATTEMPTS)
          ? 'exhausted'
          : 'pending';
      state.next_retry_at = '2026-01-01T00:01:00.000Z';
    },
    countByStatus: async () => ({ pending: 1, exhausted: 0, resolved: 0, discarded: 0 }),
  };
}

const failingPublish = async () => {
  throw new Error('receiver still down');
};

describe('manual DLQ replay does not consume the retry budget (#716)', () => {
  test('a failing manual replay leaves attempts, next_retry_at and status unchanged', async () => {
    const store = makeStore(makeRow());
    const before = { ...store.state };

    const result = await attemptRedelivery({
      dlq: store,
      row: { ...store.state },
      publish: failingPublish,
      retryOptions: RETRY_OPTIONS,
      isManual: true,
    });

    assert.equal(result.delivered, false);
    assert.equal(result.error, 'receiver still down');
    assert.equal(
      store.calls.markRetryFailed.length,
      0,
      'manual replay must not mark a retry failure',
    );
    assert.equal(store.state.dlq_attempts, before.dlq_attempts);
    assert.equal(store.state.next_retry_at, before.next_retry_at);
    assert.equal(
      store.state.status,
      'pending',
      'a near-limit message is not exhausted by a manual replay',
    );
  });

  test('repeated failing manual replays never advance a near-limit message to exhausted', async () => {
    const store = makeStore(makeRow());

    for (let i = 0; i < 3; i++) {
      const result = await attemptRedelivery({
        dlq: store,
        row: await store.get(store.state.id),
        publish: failingPublish,
        isManual: true,
      });
      assert.equal(result.delivered, false);
    }

    assert.equal(store.calls.markRetryFailed.length, 0);
    assert.equal(store.state.dlq_attempts, MAX_DLQ_ATTEMPTS - 1);
    assert.equal(store.state.status, 'pending');
  });

  test('a successful manual replay still resolves the message', async () => {
    const store = makeStore(makeRow());

    const result = await attemptRedelivery({
      dlq: store,
      row: { ...store.state },
      publish: async () => {},
      isManual: true,
    });

    assert.equal(result.delivered, true);
    assert.deepEqual(store.calls.markResolved, [store.state.id]);
    assert.equal(store.state.status, 'resolved');
  });
});

describe('automated DLQ replay still consumes the retry budget (#716)', () => {
  test('a failing automated replay calls markRetryFailed with the retry options', async () => {
    const store = makeStore(makeRow());
    const before = { ...store.state };

    const result = await attemptRedelivery({
      dlq: store,
      row: { ...store.state },
      publish: failingPublish,
      retryOptions: RETRY_OPTIONS,
      isManual: false,
    });

    assert.equal(result.delivered, false);
    assert.equal(store.calls.markRetryFailed.length, 1);
    assert.deepEqual(store.calls.markRetryFailed[0], {
      id: before.id,
      error: 'receiver still down',
      retryOptions: RETRY_OPTIONS,
    });
    assert.equal(store.state.dlq_attempts, before.dlq_attempts + 1);
    assert.notEqual(store.state.next_retry_at, before.next_retry_at);
    assert.equal(store.state.status, 'exhausted', 'automated retries still exhaust at the ceiling');
  });

  test('omitting isManual keeps the automated backoff behaviour', async () => {
    const store = makeStore(makeRow({ dlq_attempts: 1 }));

    const result = await attemptRedelivery({
      dlq: store,
      row: { ...store.state },
      publish: failingPublish,
      retryOptions: RETRY_OPTIONS,
    });

    assert.equal(result.delivered, false);
    assert.equal(store.calls.markRetryFailed.length, 1);
    assert.equal(store.state.dlq_attempts, 2);
    assert.equal(
      store.state.status,
      'pending',
      'below the ceiling the automated retry stays pending',
    );
  });

  test('pollDlqOnce drives the automated path and still counts the failure', async () => {
    const store = makeStore(makeRow({ dlq_attempts: 1 }));

    const result = await pollDlqOnce({
      dlq: store,
      publish: failingPublish,
      maxDlqAttempts: MAX_DLQ_ATTEMPTS,
      baseBackoffMs: 30_000,
      log: () => {},
    });

    assert.equal(result.claimed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.resolved, 0);
    assert.equal(store.calls.markRetryFailed.length, 1);
    assert.equal(store.state.dlq_attempts, 2);
  });
});
