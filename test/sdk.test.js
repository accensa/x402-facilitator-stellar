import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toStroops,
  validateDiscoveryDeclaration,
  createStellarDiscoveryResource,
} from '../src/sdk/index.js';

const validDeclaration = {
  routeTemplate: '/api/data/{id}',
  parameters: { id: 'The data ID' },
  pricing: { amount: '1', asset: 'USDC' },
};

test('toStroops converts decimal strings to stroops', () => {
  assert.equal(toStroops('1'), '10000000');
  assert.equal(toStroops('0.5'), '5000000');
  assert.equal(toStroops('10.1234567'), '101234567');
  assert.equal(toStroops('0.0000001'), '1');
  assert.equal(toStroops('123.456'), '1234560000');
  // Exactly 7 decimals is the representable limit — must not throw.
  assert.equal(toStroops('1.1234567'), '11234567');
  // No decimal point.
  assert.equal(toStroops('42'), '420000000');
  // A leading + is a valid decimal numeric string.
  assert.equal(toStroops('+1.5'), '15000000');
  // Zero is a valid price by policy, and it flows through conversion.
  assert.equal(toStroops('0'), '0');
  // BigInt is an exact stroop count already.
  assert.equal(toStroops(1234567n), '1234567');
  // Far beyond Number.MAX_SAFE_INTEGER — the arithmetic is BigInt, so it works.
  assert.equal(
    toStroops('123456789012345678901234567890.5'),
    '1234567890123456789012345678905000000',
  );
});

test('toStroops truncates beyond 7 decimals rather than rounding', () => {
  // Stellar's asset precision is 7 decimals; the 8th digit is dropped, not
  // rounded — rounding would invent stroops that never existed.
  assert.equal(toStroops('1.12345678'), '11234567');
  assert.equal(toStroops('0.00000001'), '0');
  assert.equal(toStroops('9.99999999'), '99999999');
});

test('toStroops rejects non-numeric input with a structured message, not a SyntaxError', () => {
  assert.throws(() => toStroops('abc'), /not a valid decimal numeric string/);
  assert.throws(() => toStroops('1e7'), /not a valid decimal numeric string/);
  assert.throws(() => toStroops('NaN'), /not a valid decimal numeric string/);
  assert.throws(() => toStroops('Infinity'), /not a valid decimal numeric string/);
  // Exponent notation like '1.5e-7' must not be coerced into 15000000 silently.
  assert.throws(() => toStroops('1.5e-7'), /not a valid decimal numeric string/);
});

test('toStroops rejects number inputs (precision already lost)', () => {
  assert.throws(() => toStroops(1), /decimal numeric string/);
  assert.throws(() => toStroops(0), /decimal numeric string/);
  assert.throws(() => toStroops(0.5), /decimal numeric string/);
});

test('toStroops rejects negatives and missing amounts', () => {
  assert.throws(() => toStroops('-1.5'), /must not be negative/);
  assert.throws(() => toStroops(''), /required/);
  assert.throws(() => toStroops(null), /required/);
  assert.throws(() => toStroops(undefined), /required/);
});

test('validateDiscoveryDeclaration rejects a missing amount', () => {
  const errors = validateDiscoveryDeclaration({
    routeTemplate: '/api/data/{id}',
    parameters: { id: 'The data ID' },
    pricing: { asset: 'USDC' },
  });
  assert.ok(errors.includes('pricing.amount is required'));
});

test('validateDiscoveryDeclaration agrees with toStroops on zero', () => {
  // Zero is a valid price — the validator and toStroops must agree.
  const withStringZero = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: '0', asset: 'USDC' },
  });
  assert.equal(withStringZero.length, 0);
  assert.equal(toStroops('0'), '0');

  // A number 0 is still a number: rejected on input shape, not on value.
  const withNumberZero = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: 0, asset: 'USDC' },
  });
  assert.ok(withNumberZero.some(e => e.includes('decimal numeric string')));
  assert.throws(() => toStroops(0));
});

test('validateDiscoveryDeclaration rejects non-numeric and over-precise amounts', () => {
  const nonNumeric = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: 'abc', asset: 'USDC' },
  });
  assert.ok(nonNumeric.some(e => e.includes('not a valid decimal numeric string')));

  // Over-precise amounts are accepted at validation and truncated on conversion.
  const overPrecise = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: '1.12345678', asset: 'USDC' },
  });
  assert.equal(overPrecise.length, 0);
  assert.equal(toStroops('1.12345678'), '11234567');

  const negative = validateDiscoveryDeclaration({
    ...validDeclaration,
    pricing: { amount: '-1', asset: 'USDC' },
  });
  assert.ok(negative.some(e => e.includes('must not be negative')));
});

test('validateDiscoveryDeclaration still reports structural errors', () => {
  const invalid = {
    routeTemplate: '/api/data/{id}',
    pricing: { amount: '1', asset: 'USDC' },
  };
  const errors = validateDiscoveryDeclaration(invalid);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('Missing description for parameter: id'));
});

test('createStellarDiscoveryResource converts amounts and fills defaults', () => {
  const res = createStellarDiscoveryResource({
    routeTemplate: '/api/ping',
    pricing: { amount: '2.5', asset: 'XLM' },
  });
  assert.equal(res.pricing.amount, '25000000');
  assert.equal(res.network, 'stellar:testnet');
  assert.equal(res.scheme, 'exact');
});

test('createStellarDiscoveryResource surfaces the same structured error as other invalid fields', () => {
  // A non-numeric amount must produce the structured declaration error, not a
  // raw BigInt SyntaxError from deep in the conversion.
  assert.throws(
    () =>
      createStellarDiscoveryResource({
        routeTemplate: '/api/ping',
        pricing: { amount: 'abc', asset: 'XLM' },
      }),
    /Invalid discovery declaration:[\s\S]*not a valid decimal numeric string/,
  );

  // Over-precise amounts are truncated, not rejected: '1.12345678' -> 11234567.
  const truncated = createStellarDiscoveryResource({
    routeTemplate: '/api/ping',
    pricing: { amount: '1.12345678', asset: 'XLM' },
  });
  assert.equal(truncated.pricing.amount, '11234567');

  // Zero is accepted end to end.
  const free = createStellarDiscoveryResource({
    routeTemplate: '/api/ping',
    pricing: { amount: '0', asset: 'XLM' },
  });
  assert.equal(free.pricing.amount, '0');
});
