import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toStroops, createStellarDiscoveryResource } from '../src/sdk/index.js';
import { STELLAR_DECIMALS } from '../src/sdk/validation.js';

/**
 * SEP-41 token amount handling (#152).
 *
 * Stellar amounts are 7-decimal fixed point. The reproducibility failure mode
 * is silent rounding — a settlement off by one stroop reconciles wrong rather
 * than failing loudly. These tests pin exact stroop equality, never
 * approximate comparison, across the decimal boundaries.
 */
describe('SEP-41 7-decimal amount handling (#152)', () => {
  test('exposes a 7-decimal precision constant', () => {
    assert.equal(STELLAR_DECIMALS, 7);
  });

  test('smallest representable unit (1 stroop) converts exactly', () => {
    assert.equal(toStroops('0.0000001'), '1');
  });

  test('one whole unit converts to 1e7 stroops exactly', () => {
    assert.equal(toStroops('1'), '10000000');
  });

  test('seven decimals are preserved exactly', () => {
    assert.equal(toStroops('1234567.8912345'), '12345678912345');
  });

  test('fewer than seven decimals are zero-padded to exact stroops', () => {
    assert.equal(toStroops('0.5'), '5000000');
    assert.equal(toStroops('3.14'), '31400000');
  });

  test('more than seven decimals are truncated, never rounded', () => {
    // The 8th+ digits are dropped, not rounded up: an off-by-stroop rounding
    // here would settle wrong rather than fail loudly.
    assert.equal(toStroops('0.99999999'), '9999999');
    assert.equal(toStroops('1.00000009'), '10000000');
  });

  test('zero is a valid amount and converts to zero stroops', () => {
    assert.equal(toStroops('0'), '0');
    assert.equal(toStroops('0.0000000'), '0');
  });

  test('a leading plus sign is accepted and normalised', () => {
    assert.equal(toStroops('+2.5'), '25000000');
  });

  test('large amounts beyond i128-friendly scales convert exactly', () => {
    // 1e12 units — far beyond typical per-payment values, checks for overflow
    // of the fixed-point conversion, not the value.
    assert.equal(toStroops('1000000000000'), '10000000000000000000');
  });

  test('negative amounts are rejected, never silently wrapped', () => {
    assert.throws(() => toStroops('-1'), /negativ/i);
  });

  test('non-numeric amounts are rejected, never coerced', () => {
    assert.throws(() => toStroops('abc'), /valid decimal numeric string/);
    // A JS number has typically already lost precision; it must be rejected.
    assert.throws(() => toStroops(2.5), /must be a decimal numeric string/);
    assert.throws(() => toStroops(null), /pricing.amount is required/);
    assert.throws(() => toStroops(''), /pricing.amount is required/);
  });

  test('createStellarDiscoveryResource carries amounts as exact stroops', () => {
    const resource = createStellarDiscoveryResource({
      routeTemplate: '/api/hello',
      pricing: {
        amount: '2.75',
        asset: 'USD',
      },
    });
    assert.equal(resource.pricing.amount, '27500000');
  });
});
