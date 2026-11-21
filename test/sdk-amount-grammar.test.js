import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { toStroops } from '../src/sdk/index.js';

/**
 * Amount-grammar regression protection (#701).
 *
 * toStroops accepts exactly the grammar validateAmount allows — an optional
 * sign, one or more ASCII digits, and an optional fractional part with at
 * least one digit — plus BigInt as an exact stroop count. These tables pin the
 * whole accepted surface so a future change to either the regex or the
 * conversion cannot silently start rounding, misread a sign, or reject a
 * format that used to work.
 */

const REQUIRED = 'pricing.amount is required';
const NUMBER_INPUT =
  'pricing.amount must be a decimal numeric string; numbers lose precision before stroop conversion';
const notDecimal = amount => `pricing.amount "${amount}" is not a valid decimal numeric string`;
const negative = amount => `pricing.amount must not be negative (got "${amount}")`;

function label(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return `${String(value)} (${typeof value})`;
}

// [input, expected stroops]
const VALID_CASES = [
  // Integers, including padded zeroes that BigInt must still read correctly.
  ['0', '0'],
  ['1', '10000000'],
  ['10', '100000000'],
  ['999', '9990000000'],
  ['000', '0'],
  ['0000001', '10000000'],
  ['+0', '0'],
  ['+42', '420000000'],

  // Fractional amounts are right-padded, not left-padded.
  ['0.5', '5000000'],
  ['+0.5', '5000000'],
  ['1.2', '12000000'],
  ['42.0', '420000000'],

  // Explicitly signed positive amounts.
  ['+1.0000000', '10000000'],
  ['+007.5000000', '75000000'],

  // Leading zeroes in the integer part.
  ['007.5', '75000000'],
  ['000.0000000', '0'],

  // Exactly seven fractional digits is representable and must not throw.
  ['0.0000000', '0'],
  ['0.0000001', '1'],
  ['+0.0000001', '1'],
  ['0.1234567', '1234567'],
  ['1.0000000', '10000000'],
  ['1.2345678', '12345678'],
  ['123.4567890', '1234567890'],

  // Beyond seven digits is truncated, never rounded.
  ['1.12345678', '11234567'],
  ['1.23456789', '12345678'],
  ['1.234567899', '12345678'],
  ['1.00000001', '10000000'],
  ['1.00000009', '10000000'],
  ['0.99999999', '9999999'],
  ['9.99999999', '99999999'],

  // Precision is carried by BigInt, not by floating point.
  ['123456789012345678901234567890.5', '1234567890123456789012345678905000000'],
];

describe('toStroops accepted amount grammar', () => {
  for (const [input, expected] of VALID_CASES) {
    test(`${label(input)} -> ${expected}`, () => {
      assert.equal(toStroops(input), expected);
    });
  }
});

// [input, exact error message]
const INVALID_CASES = [
  // Missing amounts take the required branch, not the decimal-regex branch.
  ['', REQUIRED],
  [null, REQUIRED],
  [undefined, REQUIRED],

  // Numbers are rejected on input shape even when their value is integral.
  [0, NUMBER_INPUT],
  [1, NUMBER_INPUT],
  [0.5, NUMBER_INPUT],
  [-1, NUMBER_INPUT],
  [NaN, NUMBER_INPUT],
  [Infinity, NUMBER_INPUT],

  // Negative decimal strings are a distinct, deliberate rejection.
  ['-1', negative('-1')],
  ['-0.5', negative('-0.5')],
  ['-0', negative('-0')],
  ['-1.0000000', negative('-1.0000000')],

  [-1n, negative('-1')],
  [-123456789012345678901234567890n, negative('-123456789012345678901234567890')],

  // Not the accepted decimal grammar.
  ['1e7', notDecimal('1e7')],
  ['1E7', notDecimal('1E7')],
  ['0x10', notDecimal('0x10')],
  ['NaN', notDecimal('NaN')],
  ['Infinity', notDecimal('Infinity')],
  ['-Infinity', notDecimal('-Infinity')],
  ['.5', notDecimal('.5')],
  ['1.', notDecimal('1.')],
  ['.', notDecimal('.')],
  ['+', notDecimal('+')],
  ['1.2.3', notDecimal('1.2.3')],
  ['1..0', notDecimal('1..0')],
  ['1,000', notDecimal('1,000')],
  ['1 000', notDecimal('1 000')],
  [' 1', notDecimal(' 1')],
  ['1 ', notDecimal('1 ')],
  ['\t1', notDecimal('\t1')],
  ['1\n', notDecimal('1\n')],
  ['++1', notDecimal('++1')],
  ['+-1', notDecimal('+-1')],
  ['--1', notDecimal('--1')],
  ['1_000', notDecimal('1_000')],
  ['1/2', notDecimal('1/2')],
];

describe('toStroops rejected amount grammar', () => {
  for (const [input, message] of INVALID_CASES) {
    test(`rejects ${label(input)}`, () => {
      assert.throws(
        () => toStroops(input),
        err => {
          assert.equal(err.message, message);
          return true;
        },
        `expected ${label(input)} to throw`,
      );
    });
  }
});

// [input, expected string]
const BIGINT_CASES = [
  [0n, '0'],
  [1n, '1'],
  [1234567n, '1234567'],
  [9007199254740993n, '9007199254740993'],
  [123456789012345678901234567890n, '123456789012345678901234567890'],
];

describe('toStroops BigInt passthrough', () => {
  for (const [input, expected] of BIGINT_CASES) {
    test(`${input}n -> ${expected}`, () => {
      assert.equal(toStroops(input), expected);
    });
  }
});
