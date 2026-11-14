import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryCatalogStore,
  CatalogError,
  MAX_RESOURCES_PER_PAYTO_CODE,
} from '../src/catalog/memory.js';

describe('MemoryCatalogStore upsertResource payTo counter synchronization (#769)', () => {
  test('changing payTo on an existing resource decrements old payee and increments new payee', async () => {
    const store = new MemoryCatalogStore({ maxResourcesPerPayTo: 2 });

    await store.upsertResource({
      url: 'https://api.example.com/v1/weather',
      type: 'http',
      payTo: 'G_PAYEE_A',
      description: 'Weather feed',
    });
    assert.equal(store.payToCounts.get('G_PAYEE_A'), 1);
    assert.equal(store.payToCounts.get('G_PAYEE_B'), undefined);

    const vBefore = store.getVersion();
    await store.upsertResource({
      url: 'https://api.example.com/v1/weather',
      type: 'http',
      payTo: 'G_PAYEE_B',
      description: 'Weather feed moved to B',
    });

    assert.equal(store.payToCounts.has('G_PAYEE_A'), false);
    assert.equal(store.payToCounts.get('G_PAYEE_B'), 1);
    assert.equal(store.getVersion(), vBefore + 1);
  });

  test('changing payTo to a payee already at maxResourcesPerPayTo throws CatalogError and leaves state intact', async () => {
    const store = new MemoryCatalogStore({ maxResourcesPerPayTo: 2 });

    await store.upsertResource({
      url: 'https://api.example.com/v1/r1',
      type: 'http',
      payTo: 'G_PAYEE_A',
    });
    await store.upsertResource({
      url: 'https://api.example.com/v1/r2',
      type: 'http',
      payTo: 'G_PAYEE_B',
    });
    await store.upsertResource({
      url: 'https://api.example.com/v1/r3',
      type: 'http',
      payTo: 'G_PAYEE_B',
    });

    assert.equal(store.payToCounts.get('G_PAYEE_A'), 1);
    assert.equal(store.payToCounts.get('G_PAYEE_B'), 2);

    await assert.rejects(
      () =>
        store.upsertResource({
          url: 'https://api.example.com/v1/r1',
          type: 'http',
          payTo: 'G_PAYEE_B',
        }),
      err => {
        assert.ok(err instanceof CatalogError);
        assert.equal(err.code, MAX_RESOURCES_PER_PAYTO_CODE);
        return true;
      },
    );

    // Counters and existing resource remain unchanged after rejected update
    assert.equal(store.payToCounts.get('G_PAYEE_A'), 1);
    assert.equal(store.payToCounts.get('G_PAYEE_B'), 2);
    const r1 = await store.getResource('https://api.example.com/v1/r1');
    assert.equal(r1.payTo, 'G_PAYEE_A');
  });

  test('updating an existing resource without changing payTo keeps payToCounts unchanged', async () => {
    const store = new MemoryCatalogStore({ maxResourcesPerPayTo: 1 });

    await store.upsertResource({
      url: 'https://api.example.com/v1/same',
      type: 'http',
      payTo: 'G_PAYEE_A',
      description: 'v1',
    });
    assert.equal(store.payToCounts.get('G_PAYEE_A'), 1);

    await store.upsertResource({
      url: 'https://api.example.com/v1/same',
      type: 'http',
      payTo: 'G_PAYEE_A',
      description: 'v2',
    });
    assert.equal(store.payToCounts.get('G_PAYEE_A'), 1);
  });
});
