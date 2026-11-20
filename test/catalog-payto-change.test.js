/**
 * Payee counter synchronisation when an existing resource changes payTo (#769).
 *
 * `payToCounts` is the O(1) backing store for the per-payTo catalog-flood cap
 * (#186). A listing that moves from one payee to another has to release the old
 * payee's quota and consume the new one's, and a move that would exceed the new
 * payee's cap must be refused before anything (resource, counter, version) is
 * written — otherwise the counters drift away from the real distribution and
 * the cap stops meaning anything.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryCatalogStore,
  CatalogError,
  MAX_RESOURCES_PER_PAYTO_CODE,
} from '../src/catalog/memory.js';

const resource = (url, payTo) => ({ type: 'http', url, payTo });

/** Sum of the counter map, i.e. the number of counted resources. */
const counted = store => [...store.payToCounts.values()].reduce((sum, n) => sum + n, 0);

describe('catalog payTo change maintains payToCounts (#769)', () => {
  test('changing payee decrements the old count and increments the new one', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource(resource('http://payto.ex/a', 'G_OLD'));
    await store.upsertResource(resource('http://payto.ex/b', 'G_OLD'));
    await store.upsertResource(resource('http://payto.ex/other', 'G_OTHER'));

    assert.equal(store.payToCounts.get('G_OLD'), 2);

    const updated = await store.upsertResource(resource('http://payto.ex/a', 'G_NEW'));

    assert.equal(updated.payTo, 'G_NEW');
    assert.equal(store.payToCounts.get('G_OLD'), 1, 'old payee releases the moved resource');
    assert.equal(store.payToCounts.get('G_NEW'), 1, 'new payee is charged for it');
    assert.equal(store.payToCounts.get('G_OTHER'), 1, 'unrelated payees are untouched');
  });

  test('counters match the actual distribution after several payee changes', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource(resource('http://move.ex/1', 'G_A'));
    await store.upsertResource(resource('http://move.ex/2', 'G_A'));
    await store.upsertResource(resource('http://move.ex/3', 'G_B'));

    // 1: A -> B, 2: A -> C, 3: B -> A, and 1 again: B -> C.
    await store.upsertResource(resource('http://move.ex/1', 'G_B'));
    await store.upsertResource(resource('http://move.ex/2', 'G_C'));
    await store.upsertResource(resource('http://move.ex/3', 'G_A'));
    await store.upsertResource(resource('http://move.ex/1', 'G_C'));

    // Actual distribution: 2 -> C, 3 -> A.
    const actual = new Map();
    for (const entry of store.resources.values()) {
      actual.set(entry.payTo, (actual.get(entry.payTo) ?? 0) + 1);
    }

    assert.deepEqual(Object.fromEntries(store.payToCounts), Object.fromEntries(actual));
    assert.equal(store.payToCounts.get('G_B'), undefined, 'a payee with no resources is dropped');
    assert.equal(counted(store), store.resources.size, 'counters total the catalog size');
  });

  test('a move to a payee at maxResourcesPerPayTo throws CatalogError', async () => {
    const store = new MemoryCatalogStore({ maxResourcesPerPayTo: 1 });
    await store.upsertResource(resource('http://full.ex/1', 'G_FULL'));
    await store.upsertResource(resource('http://move.ex/1', 'G_MOVING'));

    await assert.rejects(
      () => store.upsertResource(resource('http://move.ex/1', 'G_FULL')),
      err => {
        assert.ok(err instanceof CatalogError);
        assert.equal(err.code, MAX_RESOURCES_PER_PAYTO_CODE);
        assert.match(err.message, /maximum resources per payTo \(1\) exceeded/);
        return true;
      },
    );
  });

  test('a rejected move leaves the resource and both counters unchanged', async () => {
    const store = new MemoryCatalogStore({ maxResourcesPerPayTo: 1 });
    const before = await store.upsertResource(resource('http://blocked.ex/1', 'G_FROM'));
    await store.upsertResource(resource('http://blocked.ex/2', 'G_TO'));
    const versionBefore = store.getVersion();
    const lastModifiedBefore = store.getLastModified();

    await assert.rejects(
      () => store.upsertResource(resource('http://blocked.ex/1', 'G_TO')),
      CatalogError,
    );

    const stored = await store.getResource('http://blocked.ex/1');
    assert.equal(stored.payTo, 'G_FROM', 'the stored resource keeps its original payee');
    assert.equal(stored.serviceName, before.serviceName);
    assert.equal(store.payToCounts.get('G_FROM'), 1, 'the old payee keeps its quota');
    assert.equal(store.payToCounts.get('G_TO'), 1, 'the full payee is not over-charged');
    assert.equal(store.getVersion(), versionBefore, 'a refused write does not bump the version');
    assert.equal(
      store.getLastModified(),
      lastModifiedBefore,
      'a refused write does not move Last-Modified',
    );
  });

  test('a permitted change still bumps version and Last-Modified', async () => {
    const store = new MemoryCatalogStore();
    await store.upsertResource(resource('http://version.ex/1', 'G_ONE'));
    const versionBefore = store.getVersion();
    const lastModifiedBefore = store.getLastModified();

    await new Promise(resolve => setTimeout(resolve, 2));
    const updated = await store.upsertResource(resource('http://version.ex/1', 'G_TWO'));

    assert.equal(store.getVersion(), versionBefore + 1);
    assert.ok(store.getLastModified() > lastModifiedBefore);
    assert.equal(
      updated.first_seen_at,
      store.resources.get('http://version.ex/1::').first_seen_at,
      'an update keeps the original first-seen timestamp',
    );
    assert.equal(updated.payTo, 'G_TWO');
  });
});
