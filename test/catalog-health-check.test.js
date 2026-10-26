/**
 * CatalogStore.healthCheck (#584).
 *
 * The readiness snapshot seeds `catalogState = { ok: true }` and only reconsiders
 * it when the store exposes `healthCheck()`, so a store that keeps precisely the
 * problem readiness wants to report — PostgresCatalogStore's `degraded` flag —
 * had no way to say it. These tests pin the store-side half: a contract-level
 * default that is always healthy and never throws, a Postgres override that
 * surfaces the existing flag, and the readiness/proxy paths that consume it.
 *
 * The probe itself (src/readiness.js) is untouched; only the hook it already
 * calls is supplied.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { CatalogStore } from '../src/catalog/interface.js';
import { MemoryCatalogStore } from '../src/catalog/memory.js';
import { PostgresCatalogStore } from '../src/catalog/postgres.js';
import { withSearchCache } from '../src/catalog/cache.js';
import { createReadinessChecker } from '../src/readiness.js';

/**
 * A pool that refuses every statement, the same construction used by the outage
 * test in test/catalog-postgres.test.js: a store that boots against it degrades
 * to process-local memory instead of failing.
 */
function rejectingPool() {
  return {
    async query() {
      throw new Error('connection refused');
    },
    async end() {},
    on() {},
    release() {},
  };
}

/** A Postgres store that has already degraded, with its warning sink silenced. */
async function degradedStore() {
  const store = new PostgresCatalogStore(
    { maxResourcesPerPayTo: 50 },
    { pool: rejectingPool(), warn: () => {} },
  );
  await store.ready;
  return store;
}

const SECRET = Keypair.random().secret();
const ADDRESS = Keypair.fromSecret(SECRET).publicKey();

/** An rpcCall stub reporting a healthy RPC and a funded signer. */
function healthyRpcStub() {
  const account = new xdr.AccountEntry({
    accountId: Keypair.fromPublicKey(ADDRESS).xdrAccountId(),
    balance: new xdr.Int64(100_000_000),
    seqNum: new xdr.SequenceNumber(new xdr.Int64(0)),
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: '',
    thresholds: Buffer.alloc(4, 1),
    signers: [],
    ext: new xdr.AccountEntryExt(0),
  });
  const entryXdr = xdr.LedgerEntryData.account(account).toXDR('base64');
  return async (_url, body) =>
    body.method === 'getHealth'
      ? { result: { status: 'healthy' } }
      : { result: { entries: [{ xdr: entryXdr }] } };
}

function readyConfig() {
  return {
    networks: ['stellar:testnet'],
    perNetwork: { 'stellar:testnet': { secret: SECRET, rpcUrl: 'http://rpc.test' } },
    apiKeys: [],
  };
}

function checkerFor(catalog) {
  return createReadinessChecker(readyConfig(), {
    rpcCall: healthyRpcStub(),
    cacheTtlMs: 0,
    catalog,
  });
}

describe('CatalogStore.healthCheck (#584)', () => {
  test('the contract declares a healthy, never-throwing default', () => {
    const store = new CatalogStore();
    assert.equal(typeof store.healthCheck, 'function');
    assert.deepEqual(store.healthCheck(), { ok: true });
  });

  test('a memory store is healthy and a degrading Postgres store reports why', async () => {
    const memory = new MemoryCatalogStore();
    assert.deepEqual(memory.healthCheck(), { ok: true });

    const postgres = await degradedStore();
    assert.equal(postgres.degraded, true);
    const health = postgres.healthCheck();
    assert.equal(health.ok, false);
    assert.match(health.reason, /postgres|memory/);
  });

  test('readiness reports a degraded catalog without failing readiness', async () => {
    const store = await degradedStore();
    // withSearchCache is a Proxy over the store: the readiness probe sees the
    // wrapper, so the store's healthCheck must pass through it (#584).
    const wrapped = withSearchCache(store, { warn: () => {} });
    assert.equal(typeof wrapped.healthCheck, 'function');
    assert.equal(wrapped.healthCheck().ok, false, 'the Proxy must not hide the method');

    const report = await checkerFor(store).check();
    assert.equal(report.catalog.backend, 'PostgresCatalogStore');
    assert.equal(report.catalog.ok, false, 'the catalog block reports the degraded store');
    assert.equal(report.ok, true, 'catalogue trouble must not fail readiness');
    assert.equal(report.networks['stellar:testnet'].ready, true);

    // Readiness through the wrapper reaches the same method, and still does not
    // fail the probe.
    const wrappedReport = await checkerFor(wrapped).check();
    assert.equal(wrappedReport.catalog.ok, false, 'the Proxy exposes healthCheck to readiness');
    assert.equal(wrappedReport.ok, true);
  });

  test('a healthy memory catalog still reports ok and leaves readiness unchanged', async () => {
    const report = await checkerFor(new MemoryCatalogStore()).check();
    assert.equal(report.catalog.ok, true);
    assert.equal(report.ok, true);
    assert.equal(report.networks['stellar:testnet'].ready, true);
  });
});
