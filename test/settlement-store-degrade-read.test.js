/**
 * A Postgres read failure is not a missing settlement (#727).
 *
 * `PostgresSettlementStore.get` used to swallow a query error, degrade to the
 * in-memory shadow, and return `null` when the shadow did not hold the key.
 * The status route maps `null` to `404 Not Found`, so a settlement that exists
 * in Postgres was reported as absent during a database outage. These tests pin
 * the distinction: a failed read with no cached copy is a typed 503; a failed
 * read with a cached copy still serves it; only a healthy empty result is a
 * genuine miss.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresSettlementStore, StoreUnavailableError } from '../src/store/postgres.js';
import { SETTLEMENT_EVENT_TYPES } from '../src/eventstore/events.js';

const SETTLED_ROW = {
  idempotency_key: 'settlement-1',
  network: 'stellar:testnet',
  scheme: 'exact-stellar',
  payer: null,
  pay_to: null,
  asset: null,
  amount: null,
  state: 'settled',
  tx_hash: 'tx-settlement-1',
  error_reason: null,
  error_message: null,
  response: null,
  key_id: null,
  version: 2,
  created_at: new Date('2026-10-01T00:00:00Z'),
  updated_at: new Date('2026-10-01T00:00:00Z'),
};

function pool({ rows = [], selectError = null } = {}) {
  return {
    on: () => {},
    async query(sql, params = []) {
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
      if (sql.includes('FROM settlement_projections WHERE idempotency_key = $1')) {
        if (selectError) throw selectError;
        return { rows: rows.filter(r => r.idempotency_key === params[0]) };
      }
      return { rows: [] };
    },
  };
}

describe('PostgresSettlementStore read degradation (#727)', () => {
  test('a failed read with no cached copy rejects with StoreUnavailableError (503)', async () => {
    const failure = new Error('connection terminated unexpectedly');
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: pool({ selectError: failure }),
      warn: () => {},
    });
    await store.ready;

    await assert.rejects(store.get('settlement-1'), err => {
      assert.ok(err instanceof StoreUnavailableError);
      assert.equal(err.name, 'StoreUnavailableError');
      assert.equal(err.statusCode, 503);
      assert.equal(err.status, 503);
      assert.equal(err.code, 'settlement_store_unavailable');
      assert.equal(err.cause, failure);
      return true;
    });
    assert.equal(store.degraded, true);
  });

  test('a failed read with a cached copy returns the cached record', async () => {
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: pool({ selectError: new Error('connection terminated unexpectedly') }),
      warn: () => {},
    });
    await store.ready;
    store._append('settlement-1', SETTLEMENT_EVENT_TYPES.INITIATED, {
      network: SETTLED_ROW.network,
      scheme: SETTLED_ROW.scheme,
      payer: SETTLED_ROW.payer,
      pay_to: SETTLED_ROW.pay_to,
      asset: SETTLED_ROW.asset,
      amount: SETTLED_ROW.amount,
      tx_hash: SETTLED_ROW.tx_hash,
      key_id: SETTLED_ROW.key_id,
    });

    const record = await store.get('settlement-1');

    assert.equal(record.idempotency_key, 'settlement-1');
    assert.equal(record.tx_hash, 'tx-settlement-1');
    assert.equal(store.degraded, true);
  });

  test('a healthy query returning no rows is still a genuine miss', async () => {
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: pool({ rows: [] }),
      warn: () => {},
    });
    await store.ready;

    assert.equal(await store.get('settlement-1'), null);
    assert.equal(store.degraded, false);
  });

  test('getConsistent rejects with StoreUnavailableError when the read fails uncached', async () => {
    const failure = new Error('connection terminated unexpectedly');
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: pool({ selectError: failure }),
      warn: () => {},
    });
    await store.ready;

    await assert.rejects(store.getConsistent('settlement-1'), err => {
      assert.ok(err instanceof StoreUnavailableError);
      assert.equal(err.statusCode, 503);
      assert.equal(err.cause, failure);
      return true;
    });
  });
});
