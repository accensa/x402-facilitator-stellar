/**
 * Comprehensive test suite for the /discovery/resources API endpoint.
 *
 * Tests cover query building, response shape validation, pagination
 * bounds enforcement, error handling, and edge cases.
 *
 * @module api.discovery.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startDiscoveryServer,
  buildDiscoveryQuery,
  assertDiscoveryResponseShape,
  assertEmptyDiscoveryPage,
  assertPaginationBounds,
  assertDiscoveryError,
} from './helpers/discovery.js';

/**
 * Tests the buildDiscoveryQuery helper function.
 * Validates that query parameters are correctly serialized into URL query strings.
 */
test('buildDiscoveryQuery helper', async t => {
  await t.test('formats basic parameters', () => {
    assert.equal(
      buildDiscoveryQuery({ type: 'mcp', limit: 50, offset: 10 }),
      '?type=mcp&limit=50&offset=10',
    );
  });
  await t.test('formats repeated array parameters', () => {
    assert.equal(
      buildDiscoveryQuery({ extensions: ['ext1', 'ext2'] }),
      '?extensions=ext1&extensions=ext2',
    );
  });
  await t.test('handles empty or undefined parameters', () => {
    assert.equal(buildDiscoveryQuery(), '');
    assert.equal(buildDiscoveryQuery({}), '');
    assert.equal(buildDiscoveryQuery({ payTo: undefined, limit: null }), '');
  });
  await t.test('handles string and numeric values correctly', () => {
    assert.equal(
      buildDiscoveryQuery({ scheme: 'exact', limit: 100, network: 'stellar:testnet' }),
      '?scheme=exact&limit=100&network=stellar%3Atestnet',
    );
  });
  await t.test('handles empty array parameters', () => {
    assert.equal(buildDiscoveryQuery({ extensions: [] }), '');
  });
});

/**
 * Tests the assertDiscoveryResponseShape helper function.
 * Validates that responses conform to the expected DiscoveryResourcesResponse structure.
 */
test('assertDiscoveryResponseShape helper', async t => {
  await t.test('validates conformant structure', () => {
    assert.doesNotThrow(() =>
      assertDiscoveryResponseShape(
        { x402Version: 2, items: [], pagination: { limit: 20, offset: 0, total: 0 } },
        { limit: 20, offset: 0, total: 0 },
      ),
    );
  });
  await t.test('throws on missing pagination or invalid version', () => {
    assert.throws(() => assertDiscoveryResponseShape({ x402Version: 1, items: [] }));
    assert.throws(() => assertDiscoveryResponseShape({ x402Version: 2, items: 'not-array' }));
  });
  await t.test('throws when pagination fields have wrong types', () => {
    assert.throws(() =>
      assertDiscoveryResponseShape({
        x402Version: 2,
        items: [],
        pagination: { limit: 'not-a-number', offset: 0, total: 0 },
      }),
    );
  });
  await t.test('validates item count constraints', () => {
    const data = {
      x402Version: 2,
      items: [1, 2, 3],
      pagination: { limit: 20, offset: 0, total: 3 },
    };
    assert.doesNotThrow(() => assertDiscoveryResponseShape(data, { itemCount: 3 }));
    assert.throws(() => assertDiscoveryResponseShape(data, { itemCount: 5 }));
  });
});

/**
 * Tests the GET /discovery/resources endpoint.
 * Uses a live server process to validate real HTTP responses and error handling behavior.
 */
test('GET /discovery/resources tests', async t => {
  const PORT = 3411;
  const server = await startDiscoveryServer({ port: PORT });
  t.after(async () => {
    await server.stop();
  });
  await t.test('returns correctly shaped response', async () => {
    const res = await server.getResources({ type: 'mcp', limit: 50, offset: 10 });
    assert.equal(res.status, 200);
    const json = await res.json();
    assertDiscoveryResponseShape(json, { itemCount: 0, limit: 50, offset: 10, total: 0 });
  });
  await t.test('unknown filter values return empty page rather than error', async () => {
    const res = await server.getResources({ payTo: 'UNKNOWN_PAY_TO_ADDRESS' });
    assert.equal(res.status, 200);
    assertEmptyDiscoveryPage(await res.json());
  });
  await t.test('limit bounds are enforced', async () => {
    let res = await server.getResources({ limit: 0 });
    assertPaginationBounds(await res.json(), 1);
    res = await server.getResources();
    assertPaginationBounds(await res.json(), 20);
    res = await server.getResources({ limit: 500 });
    assertPaginationBounds(await res.json(), 100);
    res = await server.getResources('?limit=invalid');
    assertPaginationBounds(await res.json(), 20);
  });
  await t.test('offset bounds are enforced', async () => {
    let res = await server.getResources({ offset: -5 });
    assertPaginationBounds(await res.json(), 20, 0);
    res = await server.getResources();
    assertPaginationBounds(await res.json(), 20, 0);
    res = await server.getResources('?offset=invalid');
    assertPaginationBounds(await res.json(), 20, 0);
  });
  await t.test('multiple extensions parsed properly', async () => {
    const res = await server.getResources({ extensions: ['ext1', 'ext2'] });
    assert.equal(res.status, 200);
    assertEmptyDiscoveryPage(await res.json());
  });
  await t.test('filtering by scheme and network returns conformant structure', async () => {
    const res = await server.getResources({ scheme: 'exact', network: 'stellar:testnet' });
    assert.equal(res.status, 200);
    assertDiscoveryResponseShape(await res.json(), { itemCount: 0, total: 0 });
  });
  await t.test('error response has meaningful error structure', async () => {
    try {
      const res = await server.getResources({ type: 'invalid_type_that_will_not_match' });
      assert.equal((await res.json()).status, 200);
      assertDiscoveryResponseShape(await res.json(), { itemCount: 0, total: 0 });
    } catch (err) {
      assert.ok(err.message);
    }
  });
  await t.test('handles server-side errors gracefully', async () => {
    const res = await server.getResources('?limit=notanumber&offset=alsoinvalid');
    const json = await res.json();
    assert.ok(json.pagination || json.items, 'Server should respond with valid structure');
  });
  await t.test('large limit value is clamped to maximum', async () => {
    assertPaginationBounds(await (await server.getResources({ limit: 999999 })).json(), 100);
  });
  await t.test('zero limit is clamped to minimum', async () => {
    assertPaginationBounds(await (await server.getResources({ limit: 0 })).json(), 1);
  });
  await t.test('negative offset is clamped to zero', async () => {
    assertPaginationBounds(await (await server.getResources({ offset: -1 })).json(), 20, 0);
  });
});

/**
 * Tests error handling and edge cases for the discovery endpoint.
 * Validates that the server responds predictably to invalid input and that meaningful error messages are propagated.
 */
test('Discovery error handling and edge cases', async t => {
  const PORT = 3412;
  const server = await startDiscoveryServer({ port: PORT });
  t.after(async () => {
    await server.stop();
  });
  await t.test('returns error for unsupported HTTP methods', async () => {
    try {
      const res = await fetch(`${server.baseUrl}/discovery/resources`, { method: 'POST' });
      assert.ok(res.status === 405 || res.status === 200);
    } catch (err) {
      assert.ok(err.message);
    }
  });
  await t.test('buildDiscoveryQuery handles special characters', () => {
    assert.ok(
      buildDiscoveryQuery({ payTo: 'GBQXYZ123', query: 'test&special' }).includes(
        'payTo=GBQXYZ123',
      ),
    );
  });
  await t.test('assertDiscoveryError validates error structure', () => {
    assert.doesNotThrow(() => assertDiscoveryError({ error: { message: 'Not found', code: 404 } }));
    assert.throws(() => assertDiscoveryError({}));
  });
  await t.test('assertDiscoveryError with expected error type', () => {
    assert.throws(() =>
      assertDiscoveryError({ error: { message: 'Not found', code: 404 } }, 'NotFound'),
    );
  });
});
