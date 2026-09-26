import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startDiscoveryServer,
  buildDiscoveryQuery,
  assertDiscoveryResponseShape,
  assertEmptyDiscoveryPage,
  assertPaginationBounds,
} from './helpers/discovery.js';

test('buildDiscoveryQuery helper', async t => {
  await t.test('formats basic parameters', () => {
    const qs = buildDiscoveryQuery({ type: 'mcp', limit: 50, offset: 10 });
    assert.equal(qs, '?type=mcp&limit=50&offset=10');
  });

  await t.test('formats repeated array parameters', () => {
    const qs = buildDiscoveryQuery({ extensions: ['ext1', 'ext2'] });
    assert.equal(qs, '?extensions=ext1&extensions=ext2');
  });

  await t.test('handles empty or undefined parameters', () => {
    assert.equal(buildDiscoveryQuery(), '');
    assert.equal(buildDiscoveryQuery({}), '');
    assert.equal(buildDiscoveryQuery({ payTo: undefined, limit: null }), '');
  });
});

test('assertDiscoveryResponseShape helper', async t => {
  await t.test('validates conformant structure', () => {
    const valid = {
      x402Version: 2,
      items: [],
      pagination: { limit: 20, offset: 0, total: 0 },
    };
    assert.doesNotThrow(() =>
      assertDiscoveryResponseShape(valid, { limit: 20, offset: 0, total: 0 }),
    );
  });

  await t.test('throws on missing pagination or invalid version', () => {
    assert.throws(() => assertDiscoveryResponseShape({ x402Version: 1, items: [] }));
    assert.throws(() => assertDiscoveryResponseShape({ x402Version: 2, items: 'not-array' }));
  });
});

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

    assertDiscoveryResponseShape(json, {
      itemCount: 0,
      limit: 50,
      offset: 10,
      total: 0,
    });
  });

  await t.test('unknown filter values return empty page rather than error', async () => {
    const res = await server.getResources({ payTo: 'UNKNOWN_PAY_TO_ADDRESS' });
    assert.equal(res.status, 200);
    const json = await res.json();
    assertEmptyDiscoveryPage(json);
  });

  await t.test('limit bounds are enforced', async () => {
    // 0 is clamped to 1
    let res = await server.getResources({ limit: 0 });
    let json = await res.json();
    assertPaginationBounds(json, 1);

    // Default is 20
    res = await server.getResources();
    json = await res.json();
    assertPaginationBounds(json, 20);

    // Max is 100
    res = await server.getResources({ limit: 500 });
    json = await res.json();
    assertPaginationBounds(json, 100);

    // Non-numeric limit defaults to 20
    res = await server.getResources('?limit=invalid');
    json = await res.json();
    assertPaginationBounds(json, 20);
  });

  await t.test('offset bounds are enforced', async () => {
    // Negative is clamped to 0
    let res = await server.getResources({ offset: -5 });
    let json = await res.json();
    assertPaginationBounds(json, 20, 0);

    // Default is 0
    res = await server.getResources();
    json = await res.json();
    assertPaginationBounds(json, 20, 0);

    // Non-numeric offset defaults to 0
    res = await server.getResources('?offset=invalid');
    json = await res.json();
    assertPaginationBounds(json, 20, 0);
  });

  await t.test('multiple extensions parsed properly', async () => {
    const res = await server.getResources({ extensions: ['ext1', 'ext2'] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assertEmptyDiscoveryPage(json);
  });

  await t.test('filtering by scheme and network returns conformant structure', async () => {
    const res = await server.getResources({
      scheme: 'exact',
      network: 'stellar:testnet',
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assertDiscoveryResponseShape(json, { itemCount: 0, total: 0 });
  });
});
