/**
 * fromBaseUnits must convert fractional base units exactly (#755).
 *
 * The sub-unit branch padded to `decimals + 1` digits and then sliced the last
 * `decimals` off, so every amount smaller than one unit collapsed to "0.0":
 * 5 stroops rendered as 0.0 instead of 0.0000005. Amounts at or above one unit
 * were fine. These cases pin the whole conversion — 7-decimal native XLM,
 * 0/2/7/18-decimal custom assets, negatives, the unit boundary and trailing
 * zeros — as exact decimal strings, because this function exists precisely to
 * avoid the float that `Number(x) / 1e7` would introduce.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetDecimalsCache } from '../src/asset-cache.js';

const cache = createAssetDecimalsCache({ preloaded: new Map([['native', 7]]) });
const { fromBaseUnits } = cache;

/** Asserts each `[baseUnits, expected]` pair at the given decimals. */
function conversions(decimals, cases) {
  for (const [baseUnits, expected] of cases) {
    assert.equal(
      fromBaseUnits(baseUnits, decimals),
      expected,
      `${baseUnits} base units at ${decimals} decimals`,
    );
  }
}

describe('fromBaseUnits: native XLM (7 decimals)', () => {
  test('amounts below one unit keep every significant digit', async () => {
    const decimals = await cache.getDecimals('native');
    assert.equal(decimals, 7);

    conversions(decimals, [
      ['1', '0.0000001'],
      ['5', '0.0000005'],
      ['500000', '0.05'],
      ['999999', '0.0999999'],
      ['1000000', '0.1'],
      ['9999999', '0.9999999'],
    ]);
  });

  test('whole units and zero carry no trailing decimal', async () => {
    conversions(await cache.getDecimals('native'), [
      ['0', '0'],
      ['10000000', '1'],
      ['10000001', '1.0000001'],
      ['12345678', '1.2345678'],
    ]);
  });
});

describe('fromBaseUnits: 2-decimal asset', () => {
  test('sub-unit and whole-unit conversion', () => {
    conversions(2, [
      ['1', '0.01'],
      ['5', '0.05'],
      ['50', '0.5'],
      ['99', '0.99'],
      ['100', '1'],
      ['101', '1.01'],
      ['1000', '10'],
    ]);
  });
});

describe('fromBaseUnits: 18-decimal asset', () => {
  test('the smallest base unit is preserved in full', () => {
    conversions(18, [
      ['1', '0.000000000000000001'],
      ['5', '0.000000000000000005'],
      ['10', '0.00000000000000001'],
      ['-1', '-0.000000000000000001'],
    ]);
  });

  test('trailing fractional zeros are trimmed, not emitted', () => {
    conversions(18, [
      ['120000000000000000', '0.12'],
      ['1500000000000000000', '1.5'],
      ['5000000000000000000', '5'],
      ['1234567890123456789', '1.234567890123456789'],
    ]);
  });
});

describe('fromBaseUnits: 0-decimal asset', () => {
  test('whole units pass through unchanged and zero stays zero', () => {
    conversions(0, [
      ['0', '0'],
      ['1', '1'],
      ['5', '5'],
      ['-7', '-7'],
      ['1000', '1000'],
    ]);
  });
});

describe('fromBaseUnits: signs, boundaries and precision', () => {
  test('negative sub-unit values keep their sign', () => {
    conversions(7, [
      ['-1', '-0.0000001'],
      ['-5', '-0.0000005'],
      ['-500000', '-0.05'],
      ['-9999999', '-0.9999999'],
    ]);
  });

  test('negative whole-unit values keep their sign and drop trailing zeros', () => {
    conversions(7, [
      ['-10000000', '-1'],
      ['-15000000', '-1.5'],
      ['-12345678', '-1.2345678'],
    ]);
    conversions(2, [['-100', '-1']]);
  });

  test('the unit boundary is exact on both sides', () => {
    for (const decimals of [2, 7, 18]) {
      const unit = `1${'0'.repeat(decimals)}`;
      assert.equal(fromBaseUnits(unit, decimals), '1', `exactly one unit at ${decimals} decimals`);
      assert.equal(
        fromBaseUnits(`9${'9'.repeat(decimals - 1)}`, decimals),
        `0.${'9'.repeat(decimals)}`,
        `one base unit below the boundary at ${decimals} decimals`,
      );
      assert.equal(
        fromBaseUnits(`${unit.slice(0, -1)}1`, decimals),
        `1.${'0'.repeat(decimals - 1)}1`,
        `one base unit above the boundary at ${decimals} decimals`,
      );
    }
    // A 0-decimal asset has no boundary: the smallest base unit is one unit.
    assert.equal(fromBaseUnits('1', 0), '1');
  });

  test('no negative zero is ever rendered', () => {
    assert.equal(fromBaseUnits('0', 7), '0');
    assert.equal(fromBaseUnits('-0', 7), '0');
    assert.equal(fromBaseUnits('-0', 0), '0');
    assert.equal(fromBaseUnits('-0000000', 7), '0');
    assert.equal(fromBaseUnits(-0n, 7), '0');
  });

  test('large integer amounts lose no digits (no float arithmetic)', () => {
    // 30 digits: past Number.MAX_SAFE_INTEGER, so a float conversion would round.
    conversions(7, [['123456789012345678901234567890', '12345678901234567890123.456789']]);
    conversions(18, [['123456789012345678901234567890', '123456789012.34567890123456789']]);
  });

  test('decimals default to 7 when the asset is unspecified', () => {
    assert.equal(fromBaseUnits('5'), '0.0000005');
    assert.equal(fromBaseUnits('10000000'), '1');
  });
});

describe('fromBaseUnits: round trips through toBaseUnits', () => {
  test('exact decimal strings survive the pair of conversions', async () => {
    for (const amount of ['0.0000005', '0.0000001', '0.05', '1.2345678', '100', '0']) {
      const baseUnits = await cache.toBaseUnits(amount, 'native');
      assert.equal(fromBaseUnits(baseUnits, 7), amount, `${amount} must round-trip exactly`);
    }
  });
});
