/**
 * @description Nested discovery params never share an ETag (#683).
 *
 * `canonicalizeDiscoveryParams` used to convert every non-array value with
 * `String(v)`, so any object-valued filter collapsed to `[object Object]` and
 * two different nested filters produced the same weak validator — a client
 * polling the second got a 304 and kept the first representation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeDiscoveryParams,
  discoveryETag,
  MAX_DISCOVERY_PARAM_DEPTH,
} from '../src/catalog/discovery-cache.js';

const VERSION = 7;
const etag = params => discoveryETag(VERSION, params);

test('different nested values produce different ETags', () => {
  const usdc = etag({ extensions: { asset: 'USDC' } });
  const eurc = etag({ extensions: { asset: 'EURC' } });
  assert.notEqual(usdc, eurc);
  assert.match(usdc, /^W\/"7-[A-Za-z0-9_-]+"$/, 'validator format is unchanged');
});

test('a nested object is never serialised as [object Object]', () => {
  const canonical = canonicalizeDiscoveryParams({ extensions: { asset: 'USDC' } });
  assert.ok(!canonical.includes('[object Object]'));
  assert.deepEqual(JSON.parse(canonical), { extensions: '{"asset":"USDC"}' });
});

test('different nested keys produce different ETags', () => {
  assert.notEqual(
    etag({ extensions: { asset: 'USDC' } }),
    etag({ extensions: { network: 'USDC' } }),
  );
});

test('deeper differences are still distinguished', () => {
  assert.notEqual(
    etag({ extensions: { bazaar: { asset: 'USDC' } } }),
    etag({ extensions: { bazaar: { asset: 'EURC' } } }),
  );
});

test('reordering keys inside a nested object yields the same ETag', () => {
  assert.equal(
    etag({ extensions: { asset: 'USDC', network: 'stellar:testnet' } }),
    etag({ extensions: { network: 'stellar:testnet', asset: 'USDC' } }),
  );
  assert.equal(
    etag({ a: { x: { p: '1', q: '2' }, y: '3' } }),
    etag({ a: { y: '3', x: { q: '2', p: '1' } } }),
  );
});

test('arrays of objects: different contents differ, reordering does not', () => {
  const a = etag({ extensions: [{ asset: 'USDC' }, { asset: 'EURC' }] });
  const b = etag({ extensions: [{ asset: 'EURC' }, { asset: 'USDC' }] });
  const c = etag({ extensions: [{ asset: 'USDC' }, { asset: 'XLM' }] });
  assert.equal(a, b, 'array order of objects is not significant');
  assert.notEqual(a, c, 'array contents of objects are significant');

  // Key order inside each element is also normalised.
  assert.equal(
    etag({ extensions: [{ asset: 'USDC', network: 'n' }] }),
    etag({ extensions: [{ network: 'n', asset: 'USDC' }] }),
  );
});

test('scalar and scalar-array params serialise exactly as before', () => {
  // Byte-for-byte the pre-#683 output, so existing validators do not churn.
  assert.equal(
    canonicalizeDiscoveryParams({
      type: 'http',
      limit: 10,
      tags: ['b', 'a'],
      q: null,
      x: undefined,
    }),
    JSON.stringify({ limit: '10', tags: ['a', 'b'], type: 'http' }),
  );
  assert.equal(etag({ tags: ['b', 'a'] }), etag({ tags: ['a', 'b'] }));
});

test('a nested object and its string spelling do not collide', () => {
  assert.notEqual(etag({ extensions: { asset: 'USDC' } }), etag({ extensions: '[object Object]' }));
});

test('deep nesting terminates', () => {
  let deep = { leaf: 'v' };
  for (let i = 0; i < MAX_DISCOVERY_PARAM_DEPTH * 4; i++) deep = { n: deep };
  assert.doesNotThrow(() => etag({ extensions: deep }));
});

test('a cyclic value terminates', () => {
  const cyclic = { asset: 'USDC' };
  cyclic.self = cyclic;
  const list = [cyclic];
  list.push(list);
  assert.doesNotThrow(() => etag({ extensions: cyclic }));
  assert.doesNotThrow(() => etag({ extensions: list }));
});
