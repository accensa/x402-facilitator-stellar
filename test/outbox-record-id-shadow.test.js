/**
 * Outbox envelope keys cannot be shadowed by the payload (#707).
 *
 * `pollOutboxOnce` builds the published record by spreading `row.payload` into
 * an envelope carrying `id` and `publishedAt`. With the envelope fields first,
 * a payload that happens to contain `id` or `publishedAt` silently overwrote
 * them, so a receiver could see a payload-controlled id and a stale publish
 * time. The envelope must win while every non-conflicting payload field is
 * preserved.
 *
 * The outbox is an in-memory stub shaped like
 * `import('../src/outbox/store.js').OutboxStore`; the clock is injected so the
 * assertion is deterministic and the suite stays offline.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pollOutboxOnce } from '../src/outbox/worker.js';

function stubOutbox(rows) {
  return {
    claimBatch: async () => rows,
    markPublished: async () => {},
    markFailed: async () => {},
  };
}

describe('outbox published record id is never shadowed by the payload (#707)', () => {
  test('payload id and publishedAt cannot override the envelope fields', async () => {
    const fixedNow = new Date('2026-11-21T12:00:00Z');
    const row = {
      id: 42,
      event_id: 'evt_real',
      type: 'settlement.completed',
      payload: {
        id: 'shadowed-id',
        publishedAt: '1999-01-01T00:00:00.000Z',
        transaction: 'tx_hash',
        network: 'stellar:testnet',
      },
      attempts: 0,
    };

    const published = [];
    await pollOutboxOnce({
      outbox: stubOutbox([row]),
      publish: async record => published.push(record),
      now: () => fixedNow,
    });

    assert.equal(published.length, 1);
    const record = published[0];

    assert.equal(record.id, row.event_id, 'id must be the outbox event id');
    assert.notEqual(record.id, 'shadowed-id', 'the payload id must not win');
    assert.equal(
      record.publishedAt,
      fixedNow.toISOString(),
      'publishedAt must be the injected clock, not the payload value',
    );

    assert.equal(record.transaction, 'tx_hash', 'non-conflicting payload fields are preserved');
    assert.equal(record.network, 'stellar:testnet', 'non-conflicting payload fields are preserved');
  });
});
