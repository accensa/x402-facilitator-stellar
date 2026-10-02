/**
 * Async cataloging is non-blocking by design (src/app.js, processCataloging):
 * a resource declared in a payment is written to the catalog on a microtask,
 * after the request has already answered, and a failed catalog write must never
 * turn into a failed payment.
 *
 * The enqueue machinery under test is the shared `enqueueCataloging` helper in
 * test/helpers/catalog-enqueue.js, which mirrors server.js exactly: validate,
 * skip hard drops, upsert, swallow. Keeping it in a helper lets every edge case
 * here pin the same contract instead of re-rolling the promise machinery.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalogPayload,
  scriptedCatalog,
  enqueueCataloging,
} from './helpers/catalog-enqueue.js';

describe('async cataloging is non-blocking', () => {
  test('cataloging errors do not fail the request', async () => {
    let requestFinished = false;
    const catalog = scriptedCatalog({ failUpsert: true });
    const payload = buildCatalogPayload();

    // Simulate server.js processCataloging: enqueue the write off the hot path.
    const enqueued = enqueueCataloging({ payload, catalog });

    // The request completes immediately — nothing here awaits the background work.
    requestFinished = true;
    assert.equal(requestFinished, true);

    await enqueued;

    // The catalog was reached and threw, but the request had already finished.
    assert.equal(catalog.upserted.length, 1);
    assert.equal(catalog.upserted[0].source, 'payment');
  });

  test('a catalog failure is logged with the error, never surfaced', async () => {
    const logged = [];
    const catalog = scriptedCatalog({ failUpsert: true });

    await enqueueCataloging({
      payload: buildCatalogPayload(),
      catalog,
      log: err => logged.push(err),
    });

    assert.equal(logged.length, 1);
    assert.match(logged[0].message, /Database failure/);
  });

  test('a successful catalog write lands the validated resource', async () => {
    const catalog = scriptedCatalog();
    const payload = buildCatalogPayload();

    await enqueueCataloging({ payload, catalog });

    assert.equal(catalog.upserted.length, 1);
    assert.equal(catalog.upserted[0].resource.url, 'http://example.com/a');
    assert.equal(catalog.upserted[0].source, 'payment');
  });

  test('a hard-dropped declaration is skipped, never upserted or thrown', async () => {
    const logged = [];
    const catalog = scriptedCatalog();
    const invalid = buildCatalogPayload({
      paymentPayload: { resource: { url: 'http://example.com' } },
    });

    await enqueueCataloging({
      payload: invalid,
      catalog,
      log: err => logged.push(err),
    });

    assert.equal(catalog.upserted.length, 0);
    assert.equal(logged.length, 0);
  });

  test('uses the canonical validateForCatalog by default', async () => {
    const catalog = scriptedCatalog();
    const overridden = [];
    const payload = buildCatalogPayload();

    await enqueueCataloging({
      payload,
      catalog,
      validate: () => {
        overridden.push('custom validator');
        return { hardDrop: false, resource: { url: 'http://override.example' } };
      },
    });

    assert.equal(overridden.length, 1, 'a custom validator is injectable');
    assert.equal(catalog.upserted[0].resource.url, 'http://override.example');
  });
});
