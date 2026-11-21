/**
 * @description EXTENSION-RESPONSES status normalisation is tier-independent (#684).
 *
 * An unrecognised status used to be replaced with 'not attempted' only in the
 * tier-3 envelope, while tier 1 and tier 2 shipped it raw — so the header
 * contract was a function of payload size. These tests pin that every tier
 * agrees on the status, and that valid outcomes are still byte-identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeExtensionResponses,
  KNOWN_STATUSES,
  OMITTED_CODE,
} from '../src/catalog/extension-responses.js';

function decode(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

function rawEncode(payload) {
  return Buffer.from(JSON.stringify({ bazaar: payload })).toString('base64');
}

const UNKNOWN = 'maybe landed';

test('tier 1: an unknown status with a short reason reads "not attempted"', () => {
  const { header, omitted } = encodeExtensionResponses({
    status: UNKNOWN,
    code: 'catalog_partial',
    reason: 'short',
  });
  assert.equal(omitted, null);
  assert.deepEqual(decode(header), {
    bazaar: { status: 'not attempted', code: 'catalog_partial', reason: 'short' },
  });
});

test('tier 2: an unknown status with a 5000-character reason reads "not attempted"', () => {
  const { header, omitted } = encodeExtensionResponses({
    status: UNKNOWN,
    code: 'catalog_partial',
    reason: 'r'.repeat(5000),
  });
  assert.equal(omitted, 'reason');
  assert.deepEqual(decode(header), {
    bazaar: { status: 'not attempted', code: 'catalog_partial', detail_omitted: true },
  });
});

test('tier 3: an unknown status with an oversized structural field reads "not attempted"', () => {
  const { header, omitted } = encodeExtensionResponses({
    status: UNKNOWN,
    code: 'c'.repeat(100_000),
  });
  assert.equal(omitted, 'all');
  assert.deepEqual(decode(header), {
    bazaar: { status: 'not attempted', code: OMITTED_CODE, detail_omitted: true },
  });
});

test('the unknown status never survives into any tier', () => {
  const outcomes = [
    { status: UNKNOWN, code: 'k' },
    { status: UNKNOWN, code: 'k', reason: 'r'.repeat(5000) },
    { status: UNKNOWN, code: 'k'.repeat(100_000) },
  ];
  for (const outcome of outcomes) {
    const { header } = encodeExtensionResponses(outcome);
    assert.ok(!Buffer.from(header, 'base64').toString('utf8').includes(UNKNOWN));
  }
});

test('the caller-supplied outcome is not mutated by normalisation', () => {
  const outcome = { status: UNKNOWN, code: 'k' };
  encodeExtensionResponses(outcome);
  assert.deepEqual(outcome, { status: UNKNOWN, code: 'k' });
});

for (const status of KNOWN_STATUSES) {
  test(`valid "${status}" outcomes are byte-identical at every tier`, () => {
    // Tier 1: the whole outcome, encoded as-is.
    const small = { status, code: 'catalog_partial', reason: 'Dropped fields: description' };
    const t1 = encodeExtensionResponses(small);
    assert.equal(t1.omitted, null);
    assert.equal(t1.header, rawEncode(small));
    assert.deepEqual(decode(t1.header), { bazaar: small });

    // Tier 2: everything but `reason`, in original key order, plus the marker.
    const long = { status, code: 'catalog_partial', reason: 'r'.repeat(5000), truncated: ['a'] };
    const t2 = encodeExtensionResponses(long);
    assert.equal(t2.omitted, 'reason');
    const expected2 = { status, code: 'catalog_partial', truncated: ['a'], detail_omitted: true };
    assert.equal(t2.header, rawEncode(expected2));
    assert.deepEqual(decode(t2.header), { bazaar: expected2 });

    // Tier 3: the minimal envelope with the requested status.
    const huge = { status, code: 'c'.repeat(100_000) };
    const t3 = encodeExtensionResponses(huge);
    assert.equal(t3.omitted, 'all');
    const expected3 = { status, code: OMITTED_CODE, detail_omitted: true };
    assert.equal(t3.header, rawEncode(expected3));
    assert.deepEqual(decode(t3.header), { bazaar: expected3 });
  });
}
