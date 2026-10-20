import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toStroops, createStellarDiscoveryResource } from '../src/sdk/index.js';
import { STELLAR_DECIMALS } from '../src/sdk/validation.js';
import { validateForCatalog } from '../src/catalog/validation.js';
import { createAssetDecimalsCache } from '../src/asset-cache.js';

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

/**
 * Catalog-level sub-precision rejection (#415).
 *
 * The BigInt stroop maths above is shared and stays untouched: truncation
 * there is another issue's pinned behaviour. The catalog instead refuses to
 * list a price it cannot represent — a sub-stroop fraction is a hard drop,
 * never a silent truncation.
 */
describe('SEP-41 catalog sub-precision rejection (#415)', () => {
  function catalogResult(amount, asset, assetDecimalsMap = null) {
    const paymentPayload = {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
          pricing: { amount, asset },
        },
      },
    };
    const paymentRequirements = { network: 'stellar:testnet', payTo: 'G123', asset };
    return validateForCatalog(paymentPayload, paymentRequirements, assetDecimalsMap);
  }

  test('rejects a fractional amount for a 0-decimal asset', () => {
    const res = catalogResult('1.5', 'ZERO', { ZERO: 0 });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_pricing_amount');
  });

  test('accepts an integer amount for a 0-decimal asset', () => {
    const res = catalogResult('100', 'ZERO', { ZERO: 0 });
    assert.equal(res.hardDrop, false);
  });

  test('rejects an 8-decimal amount for 7-decimal native XLM', () => {
    const res = catalogResult('1.00000001', 'native');
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_pricing_amount');
  });

  test('accepts a 7-decimal amount for 7-decimal native XLM', () => {
    const res = catalogResult('1.0000000', 'native');
    assert.equal(res.hardDrop, false);
  });

  test('rejects a 19-decimal amount for an 18-decimal asset', () => {
    const res = catalogResult('1.0000000000000000001', 'WRAPPED', { WRAPPED: 18 });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_pricing_amount');
  });

  test('accepts an 18-decimal amount for an 18-decimal asset', () => {
    const res = catalogResult('1.000000000000000000', 'WRAPPED', { WRAPPED: 18 });
    assert.equal(res.hardDrop, false);
  });
});

describe('Asset decimals cache (#415)', () => {
  test('cache returns preloaded native XLM decimals', async () => {
    const cache = createAssetDecimalsCache({
      preloaded: new Map([
        ['native', 7],
        ['XLM', 7],
      ]),
    });
    assert.equal(await cache.getDecimals('native'), 7);
    assert.equal(await cache.getDecimals('XLM'), 7);
    assert.equal(await cache.getDecimals('xlm'), 7);
  });

  test('cache rejects unknown asset contract IDs', async () => {
    const cache = createAssetDecimalsCache({ rpcCall: null });
    await assert.rejects(cache.getDecimals('INVALID'), /Invalid asset contract ID/);
  });

  test('cache clears pending state after a failed fetch', async () => {
    const cache = createAssetDecimalsCache({
      rpcCall: null,
      preloaded: new Map(),
    });
    const contractId = 'C' + 'A'.repeat(55);
    assert.equal(cache.cache.has(contractId), false);
    await assert.rejects(cache.getDecimals(contractId));
    assert.equal(cache.cache.has(contractId), false);
  });

  test('cache clear restores preloaded entries', async () => {
    const cache = createAssetDecimalsCache({
      preloaded: new Map([['native', 7]]),
    });
    cache.clear();
    assert.equal(await cache.getDecimals('native'), 7);
  });
});
