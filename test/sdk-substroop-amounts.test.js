import test from 'node:test';
import assert from 'node:assert/strict';
import { toStroops, createStellarDiscoveryResource } from '../src/sdk/index.js';

test('toStroops rejects sub-stroop amounts that truncate to zero stroops', () => {
  // Edge cases from issue #697: 0.00000009, 0.00000001, 0.00000004, 0.00000005
  assert.throws(
    () => toStroops('0.00000009'),
    /cannot be represented.*below 1 stroop|truncate to zero/i,
  );
  assert.throws(
    () => toStroops('0.00000001'),
    /cannot be represented.*below 1 stroop|truncate to zero/i,
  );
  assert.throws(
    () => toStroops('0.00000004'),
    /cannot be represented.*below 1 stroop|truncate to zero/i,
  );
  assert.throws(
    () => toStroops('0.00000005'),
    /cannot be represented.*below 1 stroop|truncate to zero/i,
  );
  assert.throws(
    () => toStroops('+0.00000005'),
    /cannot be represented.*below 1 stroop|truncate to zero/i,
  );
  assert.throws(
    () => toStroops('0.00000000001'),
    /cannot be represented.*below 1 stroop|truncate to zero/i,
  );
});

test('toStroops preserves support for explicit zero prices', () => {
  assert.equal(toStroops('0'), '0');
  assert.equal(toStroops('0.0'), '0');
  assert.equal(toStroops('0.0000000'), '0');
  assert.equal(toStroops('+0'), '0');
  assert.equal(toStroops(0n), '0');
});

test('toStroops converts the smallest non-zero amount (0.0000001) to 1 stroop', () => {
  assert.equal(toStroops('0.0000001'), '1');
  assert.equal(toStroops('+0.0000001'), '1');
});

test('toStroops handles valid full-precision and above-stroop amounts', () => {
  assert.equal(toStroops('1'), '10000000');
  assert.equal(toStroops('0.1234567'), '1234567');
  assert.equal(toStroops('2.5'), '25000000');
  assert.equal(toStroops(1234567n), '1234567');
  // Truncation when integer part or first 7 decimals are non-zero is preserved
  assert.equal(toStroops('1.00000009'), '10000000');
  assert.equal(toStroops('0.10000009'), '1000000');
});

test('createStellarDiscoveryResource rejects sub-stroop amounts and accepts zero and valid amounts', () => {
  const baseResource = {
    routeTemplate: '/api/data',
    parameters: {},
    pricing: { asset: 'XLM' },
  };

  assert.throws(
    () =>
      createStellarDiscoveryResource({
        ...baseResource,
        pricing: { ...baseResource.pricing, amount: '0.00000004' },
      }),
    /cannot be represented.*below 1 stroop|truncate to zero/i,
  );

  const freeResource = createStellarDiscoveryResource({
    ...baseResource,
    pricing: { ...baseResource.pricing, amount: '0' },
  });
  assert.equal(freeResource.pricing.amount, '0');

  const minPaidResource = createStellarDiscoveryResource({
    ...baseResource,
    pricing: { ...baseResource.pricing, amount: '0.0000001' },
  });
  assert.equal(minPaidResource.pricing.amount, '1');
});
