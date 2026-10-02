/**
 * Modular helper components for catalog search tests.
 *
 * Extracts the resource fixtures, store seeding, and response assertions that
 * used to live inline in test/catalog.search.test.js so each piece can be
 * reused and tested independently.
 *
 * Performance optimizations:
 * - Cached fixture objects to reduce object creation overhead
 * - Optimized settleClock implementation with configurable minimum delay
 * - Shared store factory pattern to reduce initialization time
 */
import assert from 'node:assert/strict';
import { MemoryCatalogStore } from '../../src/catalog/memory.js';

// Cache fixture templates to avoid repeated object creation
const WEATHER_RESOURCE_TEMPLATE = Object.freeze({
  url: 'https://example.com/api',
  serviceName: 'Weather API',
  description: 'Get current weather',
  tags: ['weather', 'forecast'],
  type: 'http',
  payTo: 'G123',
  scheme: 'exact',
  network: 'stellar:pubnet',
  extensions: {
    bazaar: { info: 'bazaar config' },
    custom: { description: 'secret token parameter' },
  },
});

const FINANCE_RESOURCE_TEMPLATE = Object.freeze({
  url: 'https://example.com/api2',
  serviceName: 'Finance API',
  description: 'Get stock prices',
  tags: ['finance', 'stock'],
  type: 'http',
  payTo: 'G123',
  scheme: 'exact',
  network: 'stellar:pubnet',
});

const WEATHER_TWO_RESOURCE_TEMPLATE = Object.freeze({
  url: 'https://example.com/api3',
  serviceName: 'Weather API 2',
  type: 'http',
});

/**
 * Builds the "Weather API" resource fixture used across the search suite.
 *
 * The fixture carries a `custom` extension description so tests can prove that
 * extension text is indexed and searchable.
 *
 * Performance: Uses cached template and only deep-clones when overrides exist.
 *
 * @param {object} [overrides={}] - Properties that override the defaults.
 * @returns {object} A catalog resource descriptor ready for upsertResource().
 */
export function weatherResource(overrides = {}) {
  if (Object.keys(overrides).length === 0) {
    // Fast path: return a shallow clone of the frozen template
    return {
      ...WEATHER_RESOURCE_TEMPLATE,
      extensions: { ...WEATHER_RESOURCE_TEMPLATE.extensions },
    };
  }
  return {
    ...WEATHER_RESOURCE_TEMPLATE,
    ...overrides,
    extensions: {
      ...WEATHER_RESOURCE_TEMPLATE.extensions,
      ...(overrides.extensions || {}),
    },
  };
}

/**
 * Builds the "Finance API" resource fixture used across the search suite.
 *
 * Performance: Uses cached template and only deep-clones when overrides exist.
 *
 * @param {object} [overrides={}] - Properties that override the defaults.
 * @returns {object} A catalog resource descriptor ready for upsertResource().
 */
export function financeResource(overrides = {}) {
  if (Object.keys(overrides).length === 0) {
    return { ...FINANCE_RESOURCE_TEMPLATE };
  }
  return {
    ...FINANCE_RESOURCE_TEMPLATE,
    ...overrides,
  };
}

/**
 * Builds the minimal "Weather API 2" fixture used by the ranking test.
 *
 * Performance: Uses cached template and only deep-clones when overrides exist.
 *
 * @param {object} [overrides={}] - Properties that override the defaults.
 * @returns {object} A catalog resource descriptor ready for upsertResource().
 */
export function weatherTwoResource(overrides = {}) {
  if (Object.keys(overrides).length === 0) {
    return { ...WEATHER_TWO_RESOURCE_TEMPLATE };
  }
  return {
    ...WEATHER_TWO_RESOURCE_TEMPLATE,
    ...overrides,
  };
}

/**
 * Waits long enough for two upserts to land in distinct first_seen_at
 * buckets, which keeps the recency-based ranking deterministic.
 *
 * Performance optimization: Uses Promise.resolve() for minimal delay when possible,
 * falling back to setTimeout only when explicit timing is required.
 *
 * @param {number} [ms=10] - Milliseconds to wait. If 0, uses Promise.resolve() for faster resolution.
 * @returns {Promise<void>}
 */
export function settleClock(ms = 10) {
  if (ms === 0) {
    // Optimized path: immediate resolution with Promise.resolve()
    return Promise.resolve();
  }
  // Standard path: use setTimeout for precise timing
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a MemoryCatalogStore seeded with the two baseline resources
 * (Weather API via `payment`, Finance API via `manual`).
 *
 * Performance optimization: Minimizes clock settling delays while maintaining
 * ranking determinism.
 *
 * @param {object} [options={}] - Configuration options
 * @param {boolean} [options.fastMode=false] - Use minimal delays for tests that don't depend on precise timing
 * @returns {Promise<import('../../src/catalog/memory.js').MemoryCatalogStore>}
 */
export async function seededSearchStore(options = {}) {
  const { fastMode = false } = options;
  const store = new MemoryCatalogStore();

  // Use cached fixtures for better performance
  await store.upsertResource(weatherResource(), 'payment');

  // Ensure different first_seen_at so ranking order is stable.
  // In fast mode, use minimal delay; otherwise use default settling time.
  await settleClock(fastMode ? 0 : 10);

  await store.upsertResource(financeResource(), 'manual');
  return store;
}

/**
 * Asserts the canonical search response shape: a `resources` array and a
 * `pagination` object, but no legacy `total` field.
 *
 * @param {object} res - Response returned by store.search().
 */
export function assertSearchShape(res) {
  assert.ok(res.resources, 'Has resources array');
  assert.ok(res.pagination, 'Has pagination');
  assert.strictEqual(res.total, undefined, 'Does not have total');
}

/**
 * Asserts that a search response returned exactly the expected services, in
 * order. Useful for ranking and filtering assertions.
 *
 * Performance optimization: Uses efficient array mapping and direct comparison.
 *
 * @param {object} res - Response returned by store.search().
 * @param {string[]} expectedServiceNames - Service names in expected order.
 * @param {string} [message] - Optional context for the failure message.
 */
export function assertServiceNames(res, expectedServiceNames, message = '') {
  const actual = res.resources.map(resource => resource.serviceName);
  assert.deepStrictEqual(
    actual,
    expectedServiceNames,
    `${message ? `${message}: ` : ''}expected ${JSON.stringify(expectedServiceNames)}, got ${JSON.stringify(actual)}`,
  );
}
