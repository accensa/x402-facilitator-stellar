import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogStore, MAX_RESOURCES_PER_PAYTO_CODE } from '../src/catalog/memory.js';

test('Auto Cataloging Store Limits', async t => {
  const store = new MemoryCatalogStore();

  await t.test('Enforces 50 resources per payTo', async () => {
    for (let i = 0; i < 50; i++) {
      await store.upsertResource({ url: `http://example.com/${i}`, payTo: 'G123' });
    }
    await assert.rejects(
      store.upsertResource({ url: `http://example.com/50`, payTo: 'G123' }),
      err => err?.code === MAX_RESOURCES_PER_PAYTO_CODE,
    );
  });

  await t.test('Allows updates to existing resources even if at limit', async () => {
    // Updating URL 0 should succeed
    await assert.doesNotReject(
      store.upsertResource({ url: `http://example.com/0`, payTo: 'G123', serviceName: 'Updated' }),
    );
  });

  await t.test('Warns on payTo change', async () => {
    const originalWarn = console.warn;
    let warning = '';
    console.warn = msg => {
      warning = msg;
    };

    await store.upsertResource({ url: `http://example.com/0`, payTo: 'G456' });
    assert.ok(warning.includes('changed payTo from G123 to G456'));

    console.warn = originalWarn;
  });
});

describe('Catalog provenance and provisional lifecycle (#140)', () => {
  test('a verify-source upsert is provisional and expiring; a settle promotes it', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 60_000 });

    await store.upsertResource({ url: 'http://p.ex/1', payTo: 'G1' }, 'verify');
    let entry = await store.getResource('http://p.ex/1');
    assert.equal(entry.source, 'verify');
    assert.equal(entry.provisional, true);
    assert.ok(entry.expires_at != null);
    // Still discoverable before expiry.
    assert.equal((await store.listResources({})).total, 1);

    await store.upsertResource({ url: 'http://p.ex/1', payTo: 'G1' }, 'settle');
    entry = await store.getResource('http://p.ex/1');
    assert.equal(entry.source, 'settle');
    assert.equal(entry.provisional, false);
    assert.equal(entry.expires_at, null);
  });

  test('a settle landing on an old provisional entry promotes it and clears expiry', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: -1 });
    await store.upsertResource({ url: 'http://p.ex/2', payTo: 'G1' }, 'verify');
    await store.upsertResource({ url: 'http://p.ex/2', payTo: 'G1' }, 'settle');
    const entry = await store.getResource('http://p.ex/2');
    assert.equal(entry.source, 'settle');
    assert.equal(entry.provisional, false);
    assert.equal(entry.expires_at, null);
  });

  test('a verify never demotes an already-settled listing', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 1_000_000 });
    await store.upsertResource({ url: 'http://p.ex/3', payTo: 'G1' }, 'settle');
    await store.upsertResource({ url: 'http://p.ex/3', payTo: 'G1' }, 'verify');
    const entry = await store.getResource('http://p.ex/3');
    assert.equal(entry.source, 'settle');
    assert.equal(entry.provisional, false);
    assert.equal(entry.expires_at, null);
  });

  test('expired provisional listings are hidden from discovery and pruned', async () => {
    const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });

    await store.upsertResource({ url: 'http://p.ex/4', payTo: 'G1' }, 'verify');
    await store.upsertResource({ url: 'http://p.ex/4', payTo: 'G1' }, 'settle');
    await store.upsertResource({ url: 'http://e.ex/4', payTo: 'G2' }, 'verify');
    assert.equal((await store.listResources({})).total, 2);

    await new Promise(r => setTimeout(r, 20));
    // The expired verify-only entry is hidden; the settled one stays public.
    assert.equal((await store.listResources({})).total, 1);
    const pruned = await store.pruneExpired();
    assert.equal(pruned, 1);
    assert.equal((await store.listResources({})).total, 1);
  });
});
