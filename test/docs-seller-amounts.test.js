/**
 * The seller documentation must state the amount type rules the SDK enforces
 * (#704).
 *
 * docs/SELLER.md used to show `pricing: { amount: '2.5' }` without explaining
 * why numbers are rejected, why precision is 7 decimals, or why fractions past
 * that are truncated instead of rounded. These tests keep the prose honest
 * against the SDK constants so the guide cannot drift from the validator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STELLAR_DECIMALS, validateAmount } from '../src/sdk/validation.js';
import { toStroops } from '../src/sdk/index.js';

const sellerDoc = readFileSync(new URL('../docs/SELLER.md', import.meta.url), 'utf8');

test('docs/SELLER.md documents the amount type rules the seller SDK enforces', () => {
  assert.match(sellerDoc, /STELLAR_DECIMALS/, 'the seller guide must name the precision constant');
  assert.match(sellerDoc, /decimal numeric string/);
  assert.match(sellerDoc, /BigInt/);
  assert.match(sellerDoc, /numbers lose precision/);
  assert.match(sellerDoc, /truncated, not rounded/);
});

test('the documented precision rules match the SDK constants', () => {
  assert.equal(STELLAR_DECIMALS, 7);
  assert.match(
    sellerDoc,
    new RegExp(`\\b${STELLAR_DECIMALS}\\b`),
    'the guide must state the decimal count',
  );
});

test('the documented valid and invalid amount examples match the validator', () => {
  assert.deepEqual(validateAmount('1.5'), []);
  assert.deepEqual(validateAmount('0'), []);
  assert.deepEqual(validateAmount(25000000n), []);
  assert.deepEqual(validateAmount(-25000000n), [
    'pricing.amount must not be negative (got "-25000000")',
  ]);
  assert.deepEqual(validateAmount(1.5), [
    'pricing.amount must be a decimal numeric string; numbers lose precision before stroop conversion',
  ]);
  assert.deepEqual(validateAmount('-1.5'), ['pricing.amount must not be negative (got "-1.5")']);
  assert.deepEqual(validateAmount('1e7'), [
    'pricing.amount "1e7" is not a valid decimal numeric string',
  ]);
});

test('sub-stroop fractions are truncated, never rounded', () => {
  assert.equal(toStroops('1.12345678'), '11234567');
  assert.throws(() => toStroops('0.00000001'), /cannot be represented in stroops/);
});
