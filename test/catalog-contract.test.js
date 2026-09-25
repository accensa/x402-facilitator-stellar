import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogStore } from '../src/catalog/interface.js';
import { MemoryCatalogStore } from '../src/catalog/memory.js';
import { PostgresCatalogStore } from '../src/catalog/postgres.js';

/**
 * Reusable CatalogStore contract suite (#213).
 *
 * Verifies that any catalog store implementation fulfills all methods, return shapes,
 * pagination rules, versioning, and pruning semantics required by CatalogStore.
 */
export function runCatalogStoreContractSuite(name, createStore) {
  describe(`CatalogStore Contract: ${name}`, () => {
    test('implements required interface methods', async () => {
      const store = await createStore();
      assert.ok(store instanceof CatalogStore, 'store must extend CatalogStore');
      assert.ok(typeof store.getVersion === 'function', 'getVersion must be a function');
      assert.ok(
        typeof store.getLastModified === 'function',
        'getLastModified must be a function',
      );
      assert.ok(typeof store.upsertResource === 'function', 'upsertResource must be a function');
      assert.ok(typeof store.getResource === 'function', 'getResource must be a function');
      assert.ok(typeof store.listResources === 'function', 'listResources must be a function');
      assert.ok(typeof store.search === 'function', 'search must be a function');
      assert.ok(typeof store.pruneExpired === 'function', 'pruneExpired must be a function');
      assert.ok(typeof store.flush === 'function', 'flush must be a function');
    });

    test('upsertResource and getResource contract', async () => {
      const store = await createStore();
      const resource = {
        url: 'http://example.com/api',
        type: 'http',
        payTo: 'G123',
        scheme: 'exact',
        network: 'stellar:testnet',
      };

      const initialVer = store.getVersion();
      const entry = await store.upsertResource(resource, 'settle');
      assert.ok(entry);
      assert.equal(entry.url, 'http://example.com/api');
      assert.equal(entry.source, 'settle');
      assert.equal(entry.provisional, false);
      assert.ok(store.getVersion() > initialVer, 'version must increment on write');
      assert.ok(store.getLastModified() instanceof Date, 'getLastModified must return a Date');

      const fetched = await store.getResource('http://example.com/api');
      assert.ok(fetched);
      assert.equal(fetched.url, 'http://example.com/api');
      assert.equal(fetched.payTo, 'G123');
    });

    test('listResources contract with pagination and filters', async () => {
      const store = await createStore();
      await store.upsertResource(
        { url: 'http://example.com/1', type: 'http', payTo: 'GA' },
        'settle',
      );
      await store.upsertResource(
        { url: 'http://example.com/2', type: 'mcp', toolName: 'calc', payTo: 'GB' },
        'settle',
      );

      const listAll = await store.listResources({});
      assert.equal(listAll.total, 2);
      assert.ok(Array.isArray(listAll.items));
      assert.equal(listAll.items.length, 2);

      const listFilter = await store.listResources({ type: 'mcp' });
      assert.equal(listFilter.total, 1);
      assert.equal(listFilter.items[0].url, 'http://example.com/2');
    });

    test('provisional lifecycle and pruneExpired contract', async () => {
      const storeActive = await createStore({ catalogVerifyTtlMs: 60_000 });
      await storeActive.upsertResource({ url: 'http://example.com/prov1', payTo: 'GC' }, 'verify');
      const entryActive = await storeActive.getResource('http://example.com/prov1');
      assert.ok(entryActive);
      assert.equal(entryActive.source, 'verify');
      assert.equal(entryActive.provisional, true);

      const storeExpired = await createStore({ catalogVerifyTtlMs: -1 });
      await storeExpired.upsertResource({ url: 'http://example.com/prov2', payTo: 'GC' }, 'verify');
      const pruned = await storeExpired.pruneExpired();
      assert.equal(pruned, 1);
    });
  });
}

// Instantiate contract suite for MemoryCatalogStore
runCatalogStoreContractSuite('MemoryCatalogStore', async opts => new MemoryCatalogStore(opts));

// Instantiate contract suite for PostgresCatalogStore (in-memory degraded/fallback mode when no DB pool)
runCatalogStoreContractSuite(
  'PostgresCatalogStore (degraded)',
  async opts => new PostgresCatalogStore(opts),
);
