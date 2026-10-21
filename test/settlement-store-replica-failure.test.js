/**
 * Settlement store replica-outage containment (#582).
 *
 * `_queryGetWithLag` used to await the replica with no per-attempt guard, so a
 * rejecting replica unwound into `getConsistent`'s catch and degraded the whole
 * store to process-local memory for the life of the process — even though the
 * primary was healthy and is exactly where the confirmation read goes. These
 * tests pin the two sides: a replica rejection is contained and answered from
 * the primary; a primary rejection still degrades and falls back to memory.
 *
 * The pools are minimal pg-shaped doubles: `query()` and `on('error')`. The
 * primary can serve projection rows or reject the projection SELECT, and the
 * replica can reject every query.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresSettlementStore } from '../src/store/postgres.js';

const SETTLED_ROW = {
  idempotency_key: 'replica-outage-1',
  network: 'stellar:testnet',
  scheme: 'exact-stellar',
  payer: null,
  pay_to: null,
  asset: null,
  amount: null,
  state: 'settled',
  tx_hash: 'tx-replica-outage',
  error_reason: null,
  error_message: null,
  response: null,
  key_id: null,
  version: 2,
  created_at: new Date('2026-10-01T00:00:00Z'),
  updated_at: new Date('2026-10-01T00:00:00Z'),
};

function refusingPool(error = new Error('replica connection terminated')) {
  return {
    on: () => {},
    query: async () => {
      throw error;
    },
  };
}

function primaryPool({ rows = [], rejectSelect = null } = {}) {
  return {
    on: () => {},
    query: async (sql, params = []) => {
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
      if (sql.includes('FROM settlement_projections WHERE idempotency_key = $1')) {
        if (rejectSelect) throw rejectSelect;
        return { rows: rows.filter(r => r.idempotency_key === params[0]) };
      }
      return { rows: [] };
    },
  };
}

describe('PostgresSettlementStore replica outage (#582)', () => {
  test('a rejecting replica is contained: the primary row is returned and nothing degrades', async () => {
    const warned = [];
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: primaryPool({ rows: [SETTLED_ROW] }),
      replicaPool: refusingPool(),
      replicaLagMs: 40,
      warn: msg => warned.push(msg),
    });
    await store.ready;

    const row = await store.getConsistent('replica-outage-1');

    assert.equal(row.state, 'settled');
    assert.equal(row.tx_hash, 'tx-replica-outage');
    assert.equal(store.degraded, false, 'a replica-only failure must not latch degraded');
    assert.deepEqual(warned, []);
  });

  test('a rejecting primary still degrades and falls back to the in-memory read', async () => {
    const warned = [];
    const store = new PostgresSettlementStore('postgres://primary', {
      pool: primaryPool({ rejectSelect: new Error('primary connection terminated') }),
      replicaPool: primaryPool(),
      replicaLagMs: 10,
      warn: msg => warned.push(msg),
    });
    await store.ready;

    const row = await store.getConsistent('replica-outage-2');

    assert.equal(row, null, 'the empty in-memory store answers the fallback read');
    assert.equal(store.degraded, true);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /getConsistent failed: primary connection terminated/);
  });
});
