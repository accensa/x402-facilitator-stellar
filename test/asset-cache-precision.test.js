/**
 * `fromBaseUnits` must format every representable amount exactly (#755).
 *
 * Base units (stroops for XLM, atomic subunits for a SEP-0041 token) were
 * truncated to zero for any amount smaller than one whole unit: 5 stroops at 7
 * decimals rendered "0.0", so a balance, refund or settlement report for a real
 * on-chain amount read as zero. These tests pin the exact decimal *string* —
 * never a Number, so nothing here can pass through floating-point arithmetic —
 * across the 0, 2, 7 and 18 decimal assets the facilitator serves.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetDecimalsCache } from '../src/asset-cache.js';

// fromBaseUnits takes the decimals explicitly, so no RPC and no cache warm-up
// is needed to exercise it.
const cache = createAssetDecimalsCache({ rpcCall: null, preloaded: new Map() });
const fromBaseUnits = (baseUnits, decimals) => cache.fromBaseUnits(baseUnits, decimals);

describe('fromBaseUnits: native XLM / 7 decimals (#755)', () => {
  test('sub-unit amounts are padded to the full 7 decimals', () => {
    assert.equal(fromBaseUnits(5, 7), '0.0000005');
    assert.equal(fromBaseUnits(1, 7), '0.0000001');
    assert.equal(fromBaseUnits(500000, 7), '0.05');
    assert.equal(fromBaseUnits(1000000, 7), '0.1');
  });

  test('a whole unit drops the decimal point instead of returning ".0"', () => {
    assert.equal(fromBaseUnits(10000000, 7), '1');
    assert.equal(fromBaseUnits(15000000, 7), '1.5');
  });

  test('zero base units format as "0"', () => {
    assert.equal(fromBaseUnits(0, 7), '0');
    assert.equal(fromBaseUnits(0n, 7), '0');
    assert.equal(fromBaseUnits('000', 7), '0');
  });

  test('7 decimals is the default when the asset is not stated', () => {
    assert.equal(cache.fromBaseUnits(5), '0.0000005');
    assert.equal(cache.fromBaseUnits(10000000), '1');
  });
});

describe('fromBaseUnits: 2-decimal asset (#755)', () => {
  test('sub-unit amounts use the asset precision', () => {
    assert.equal(fromBaseUnits(5, 2), '0.05');
    assert.equal(fromBaseUnits(1, 2), '0.01');
    assert.equal(fromBaseUnits(99, 2), '0.99');
  });

  test('trailing fractional zeros are trimmed', () => {
    assert.equal(fromBaseUnits(50, 2), '0.5');
    assert.equal(fromBaseUnits(10, 2), '0.1');
  });

  test('a whole unit drops the decimal point', () => {
    assert.equal(fromBaseUnits(100, 2), '1');
    assert.equal(fromBaseUnits(250, 2), '2.5');
  });

  test('zero base units format as "0"', () => {
    assert.equal(fromBaseUnits(0, 2), '0');
  });
});

describe('fromBaseUnits: 18-decimal asset (#755)', () => {
  test('single atomic units keep all 18 decimals', () => {
    assert.equal(fromBaseUnits(1, 18), '0.000000000000000001');
    assert.equal(fromBaseUnits(5, 18), '0.000000000000000005');
  });

  test('trailing fractional zeros are trimmed, leading zeros are kept', () => {
    assert.equal(fromBaseUnits('100000000000000000', 18), '0.1');
    assert.equal(fromBaseUnits('123000000000000000', 18), '0.123');
    assert.equal(fromBaseUnits('1230000000000000000', 18), '1.23');
  });

  test('a whole unit drops the decimal point', () => {
    assert.equal(fromBaseUnits('1000000000000000000', 18), '1');
  });

  test('zero base units format as "0"', () => {
    assert.equal(fromBaseUnits(0n, 18), '0');
  });
});

describe('fromBaseUnits: 0-decimal asset (#755)', () => {
  test('whole units are returned unchanged, with no decimal point', () => {
    assert.equal(fromBaseUnits(42, 0), '42');
    assert.equal(fromBaseUnits(1, 0), '1');
    assert.equal(fromBaseUnits(-42, 0), '-42');
  });

  test('zero base units format as "0"', () => {
    assert.equal(fromBaseUnits(0, 0), '0');
    assert.equal(fromBaseUnits(0n, 0), '0');
  });

  test('large integer values are not truncated', () => {
    assert.equal(
      fromBaseUnits('123456789012345678901234567890', 0),
      '123456789012345678901234567890',
    );
  });
});

describe('fromBaseUnits: sign handling (#755)', () => {
  test('negative sub-unit amounts keep their sign', () => {
    assert.equal(fromBaseUnits(-5, 7), '-0.0000005');
    assert.equal(fromBaseUnits(-500000, 7), '-0.05');
    assert.equal(fromBaseUnits(-1, 18), '-0.000000000000000001');
  });

  test('negative whole-unit amounts keep their sign', () => {
    assert.equal(fromBaseUnits(-10000000, 7), '-1');
    assert.equal(fromBaseUnits(-15000000, 7), '-1.5');
  });

  test('a negative zero is never emitted', () => {
    assert.equal(fromBaseUnits(-0, 7), '0');
    assert.equal(fromBaseUnits(-0n, 7), '0');
    assert.equal(fromBaseUnits('-0', 7), '0');
    assert.equal(fromBaseUnits('-000', 2), '0');
  });
});

describe('fromBaseUnits: decimal boundary (#755)', () => {
  test('values exactly at, just below and just above the boundary', () => {
    // 7 digits is exactly `decimals`, 8 digits is the first whole unit.
    assert.equal(fromBaseUnits(9999999, 7), '0.9999999');
    assert.equal(fromBaseUnits(10000000, 7), '1');
    assert.equal(fromBaseUnits(10000001, 7), '1.0000001');
  });

  test('the same boundary holds at 2 decimals', () => {
    assert.equal(fromBaseUnits(99, 2), '0.99');
    assert.equal(fromBaseUnits(100, 2), '1');
    assert.equal(fromBaseUnits(101, 2), '1.01');
  });

  test('the same boundary holds at 18 decimals', () => {
    assert.equal(fromBaseUnits('999999999999999999', 18), '0.999999999999999999');
    assert.equal(fromBaseUnits('1000000000000000000', 18), '1');
    assert.equal(fromBaseUnits('1000000000000000001', 18), '1.000000000000000001');
  });
});

describe('fromBaseUnits: exactness (#755)', () => {
  test('fractional trailing zeros are trimmed, not rounded', () => {
    assert.equal(fromBaseUnits(12000000, 7), '1.2');
    assert.equal(fromBaseUnits(12340000, 7), '1.234');
    assert.equal(fromBaseUnits(12345670, 7), '1.234567');
  });

  test('large values keep every digit (no Number round-trip)', () => {
    // 30 digits and 7 decimals: a Number would lose the low-order digits.
    assert.equal(
      fromBaseUnits(123456789012345678901234567890n, 7),
      '12345678901234567890123.456789',
    );
    assert.equal(
      fromBaseUnits('123456789012345678901234567891', 18),
      '123456789012.345678901234567891',
    );
  });
});
