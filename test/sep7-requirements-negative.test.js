import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { payUriFromRequirements, parsePayUri, Sep7Error } from '../src/sdk/sep7.js';

const DEST = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';

function rejectsAmount(amount, pattern) {
  assert.throws(
    () => payUriFromRequirements({ payTo: DEST, amount }),
    err => {
      assert.ok(err instanceof Sep7Error, `expected Sep7Error for ${String(amount)}`);
      assert.match(err.message, pattern);
      assert.equal(
        err.message.includes('web+stellar:'),
        false,
        'the rejected amount must not be emitted as a URI',
      );
      return true;
    },
  );
}

describe('payUriFromRequirements rejects invalid stroop amounts (#757)', () => {
  test('negative BigInt stroops never reach the modulo/division conversion', () => {
    rejectsAmount(-50n, /amount must not be negative/);
    rejectsAmount(-12345678901234567890n, /amount must not be negative/);
  });

  test('negative decimal strings are rejected as Sep7Error', () => {
    rejectsAmount('-50', /amount must not be negative/);
    rejectsAmount('-0.000005', /amount must not be negative/);
  });

  test('invalid amount types and strings are rejected as Sep7Error', () => {
    rejectsAmount(-1, /decimal numeric string/);
    rejectsAmount(1.5, /decimal numeric string/);
    rejectsAmount('abc', /not a valid decimal numeric string/);
    rejectsAmount('1e7', /not a valid decimal numeric string/);
    rejectsAmount('', /amount is required/);
    rejectsAmount(null, /amount is required/);
  });

  test('a fractional string is not a valid integer stroop count', () => {
    rejectsAmount('2.5', /not a valid stroop count/);
  });
});

describe('payUriFromRequirements formats non-negative stroops cleanly (#757)', () => {
  const CASES = [
    [0n, '0'],
    [1n, '0.0000001'],
    [50n, '0.000005'],
    [10000000n, '1'],
    [12345678n, '1.2345678'],
    ['1201234567', '120.1234567'],
  ];

  for (const [amount, expected] of CASES) {
    test(`${String(amount)} -> ${expected}`, () => {
      const uri = payUriFromRequirements({ payTo: DEST, amount });
      assert.equal(parsePayUri(uri).amount, expected);
    });
  }

  test('zero stroops produces a plain zero without a fractional part', () => {
    const uri = payUriFromRequirements({ payTo: DEST, amount: 0n });
    assert.match(uri, /amount=0(?:&|$)/);
    assert.equal(uri.includes('-'), false);
  });
});
