/**
 * Durable Postgres catalog store (#139).
 *
 * The store must survive a restart, reuse the existing PostgreSQL dependency,
 * keep embeddings warm without a wholesale re-embed, and — above all — an
 * outage of the backing Postgres must never fail or delay a payment. No
 * external service here: a fake pg Pool stands in for Postgres, and the same
 * data Map handed to a second store instance simulates the durable bytes that
 * would survive a process restart.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { serve, stubFacilitator } from './helpers/app.js';
import { MemoryCatalogStore } from '../src/catalog/memory.js';
import { PostgresCatalogStore, buildCatalogStore } from '../src/catalog/postgres.js';

/**
 * Fake pg Pool — enough for PostgresCatalogStore's CREATE / UPSERT / SELECT /
 * DELETE statements. `data` is the "durable" store: hand the same Map to a
 * second store to observe what a restart would recover. `fail` simulates an
 * unreachable database.
 */
function fakePool({ fail = false, data = new Map() } = {}) {
  return {
    data,
    async query(sql, params = []) {
      if (fail) throw new Error('connection refused');

      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return {};

      if (/INSERT.*ON CONFLICT/s.test(sql)) {
        const [key, resource, source, provisional, expiresAt, firstSeenAt, lastSeenAt, embedding] =
          params;
        data.set(key, {
          key,
          resource: JSON.parse(resource),
          source,
          provisional,
          // node-postgres returns int8 as a string.
          expires_at: expiresAt == null ? null : String(expiresAt),
          first_seen_at: firstSeenAt,
          last_seen_at: lastSeenAt,
          embedding: embedding ? JSON.parse(embedding) : null,
        });
        return { rows: [data.get(key)] };
      }

      if (/SELECT/.test(sql)) {
        return { rows: [...data.values()] };
      }

      if (/DELETE/.test(sql)) {
        for (const key of params[0] ?? []) data.delete(key);
        return {};
      }

      return {};
    },
    async end() {},
    on() {},
    release() {},
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  };
}

function settledResource(url = 'http://api.ex/139') {
  return {
    type: 'http',
    url,
    serviceName: 'durable-catalog',
    description: 'demo resource for #139',
    scheme: 'exact',
    network: 'stellar:testnet',
    payTo: 'G000000000000000000000000000000000000000000000139',
  };
}

const storeConfig = { maxResourcesPerPayTo: 50 };

describe('PostgresCatalogStore (issue #139)', () => {
  test('catalogued resources survive a restart', async () => {
    const data = new Map();
    const pool = fakePool({ data });
    const storeA = new PostgresCatalogStore(storeConfig, { pool });
    await storeA.ready;
    await storeA.upsertResource(settledResource(), 'settle');

    // A second store over the same durable bytes is a restarted process.
    const storeB = new PostgresCatalogStore(storeConfig, { pool });
    await storeB.ready;
    const recovered = await storeB.getResource('http://api.ex/139');
    assert.ok(recovered, 'resource must be present after restart');
    assert.equal(recovered.source, 'settle');
    assert.equal(recovered.provisional, false);
    assert.equal(recovered.expires_at, null);
    assert.ok(recovered.first_seen_at instanceof Date);
    assert.doesNotReject(() => storeA.flush());

    // And it is queryable exactly like a freshly-written one.
    const { items } = await storeB.listResources({});
    assert.equal(items.length, 1);
    assert.equal(items[0].serviceName, 'durable-catalog');
  });

  test('a provisional verify-only listing survives restart with its expiry', async () => {
    const data = new Map();
    const pool = fakePool({ data });
    const storeA = new PostgresCatalogStore(storeConfig, { pool });
    await storeA.ready;
    await storeA.upsertResource(settledResource('http://verify.ex/139'), 'verify');
    const before = await storeA.getResource('http://verify.ex/139');
    assert.equal(before.provisional, true);
    assert.ok(before.expires_at > Date.now());

    const storeB = new PostgresCatalogStore(storeConfig, { pool });
    await storeB.ready;
    const after = await storeB.getResource('http://verify.ex/139');
    assert.equal(after.provisional, true);
    assert.ok(
      after.expires_at > Date.now(),
      'verify-only listing must still know when it expires after a restart',
    );
    assert.equal(after.source, 'verify');
  });

  test('hydration preserves the per-payTo cap for restored rows', async () => {
    const data = new Map();
    const pool = fakePool({ data });
    const storeA = new PostgresCatalogStore({ ...storeConfig, maxResourcesPerPayTo: 2 }, { pool });
    await storeA.ready;
    await storeA.upsertResource(settledResource('http://api.ex/a'), 'settle');
    await storeA.upsertResource(settledResource('http://api.ex/b'), 'settle');

    const storeB = new PostgresCatalogStore({ ...storeConfig, maxResourcesPerPayTo: 2 }, { pool });
    await storeB.ready;
    await assert.rejects(
      () => storeB.upsertResource(settledResource('http://api.ex/c')),
      err => err?.code === 'maximum_resources_per_payto_exceeded',
    );
  });

  test('pruneExpired also removes the durable rows', async () => {
    const data = new Map();
    const pool = fakePool({ data });
    const store = new PostgresCatalogStore({ ...storeConfig, catalogVerifyTtlMs: 50 }, { pool });
    await store.ready;
    await store.upsertResource(settledResource('http://verify.ex/prune'), 'verify');
    assert.equal(data.size, 1);
    await new Promise(r => setTimeout(r, 70));
    const pruned = await store.pruneExpired();
    assert.equal(pruned, 1);
    assert.equal(data.size, 0, 'the durable row must be pruned too');
  });

  test('an outage degrades without failing catalog writes or reads', async () => {
    const pool = fakePool({ fail: true });
    const store = new PostgresCatalogStore(storeConfig, { pool });
    await store.ready;
    assert.equal(store.degraded, true);

    const entry = await store.upsertResource(settledResource(), 'settle');
    assert.ok(entry, 'upsert must succeed from memory during an outage');
    assert.equal((await store.getResource('http://api.ex/139')).serviceName, 'durable-catalog');
  });

  test('an outage cannot fail a payment over HTTP', async () => {
    const store = new PostgresCatalogStore(storeConfig, { pool: fakePool({ fail: true }) });
    await store.ready;
    const app = await serve({
      catalog: store,
      facilitator: stubFacilitator({
        settle: async () => ({ success: true, transaction: 'tx', network: 'stellar:testnet' }),
      }),
    });
    try {
      const body = {
        paymentPayload: {
          x402Version: 2,
          scheme: 'exact',
          network: 'stellar:testnet',
          resource: {
            url: 'http://api.ex/outage',
            serviceName: 'outage-demo',
            description: 'demo',
          },
          extensions: {
            bazaar: {
              info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
              schema: { type: 'object' },
              routeTemplate: '/outage',
            },
          },
        },
        paymentRequirements: {
          scheme: 'exact',
          network: 'stellar:testnet',
          asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          maxAmountRequired: '1000',
          payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
        },
      };
      const res = await app.post('/settle', body);
      assert.equal(res.status, 200, 'settlement must succeed while the catalog store is down');
    } finally {
      await app.close();
    }
  });

  test('buildCatalogStore selects Postgres only when DATABASE_URL is set', () => {
    const warnings = [];
    const mem = buildCatalogStore({}, { log: msg => warnings.push(msg) });
    assert.ok(mem instanceof MemoryCatalogStore);
    assert.ok(warnings.some(w => w.includes('DATABASE_URL is unset')));

    const pg = buildCatalogStore(
      { databaseUrl: 'postgres://localhost/x402' },
      { pool: fakePool(), log: () => {} },
    );
    assert.ok(pg instanceof PostgresCatalogStore);
  });
});
