import test from 'node:test';
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
