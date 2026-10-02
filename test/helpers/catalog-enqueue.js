/**
 * Shared fixtures and the enqueue pattern for the async-cataloging suite
 * (test/server.catalog.test.js).
 *
 * server.js catalogs resources declared in a payment *off the hot path*:
 * the expensive work is enqueued on a microtask and never delays or fails the
 * request that triggered it; whatever the catalog throws is logged and dropped.
 * `enqueueCataloging` holds exactly that machinery so the non-blocking contract
 * is written once and pinned by every test, while the others here only describe
 * the shape of the real payload and a catalog store that can be made to fail.
 */
import { validateForCatalog } from '../../src/catalog/validation.js';

/**
 * A payment payload / paymentRequirements pair that passes validateForCatalog.
 *
 * Mirrors the request body shape the verify/settle handlers forward to
 * processCataloging in src/app.js.
 */
export function buildCatalogPayload(overrides = {}) {
  const payload = {
    paymentPayload: {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
        },
      },
    },
    paymentRequirements: { payTo: 'G123', network: 'stellar:testnet' },
  };
  return { ...payload, ...overrides };
}

/**
 * A catalog store stub that records every upsert and can be scripted to fail,
 * mirroring the `upsertResource` surface used by processCataloging.
 */
export function scriptedCatalog({ failUpsert = false } = {}) {
  const upserted = [];
  return {
    upserted,
    upsertResource: async (resource, source) => {
      upserted.push({ resource, source });
      if (failUpsert) throw new Error('Database failure');
      return { ...resource, source };
    },
  };
}

/**
 * Simulates the fire-and-forget catalog write server.js runs after a payment:
 * validate the payload, upsert the resource, and swallow whatever fails so a
 * background catalog error can never fail the request. Returns the enqueued
 * promise so a test can await completion before asserting.
 */
export function enqueueCataloging({
  payload,
  catalog,
  validate = validateForCatalog,
  log = () => {},
}) {
  return Promise.resolve().then(async () => {
    try {
      const validation = validate(payload.paymentPayload, payload.paymentRequirements);
      if (validation.hardDrop) {
        return;
      }
      await catalog.upsertResource(validation.resource, 'payment');
    } catch (err) {
      log(err);
    }
  });
}
