/**
 * @description Bounded EXTENSION-RESPONSES encoding (#202).
 *
 * The header is assembled from caller-controlled values and was previously
 * encoded with no size limit. A header over the proxy's cap does not truncate
 * — it kills the response, on the payment path, after settlement. These tests
 * pin the three degradation tiers and, crucially, that the ordinary case is
 * unchanged byte-for-byte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeExtensionResponses,
  MAX_EXTENSION_RESPONSES_HEADER_BYTES,
  KNOWN_STATUSES,
  OMITTED_CODE,
} from '../src/catalog/extension-responses.js';

/** Decodes a header value back into its envelope, asserting it is valid base64 JSON. */
function decode(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

test('A fitting envelope is byte-identical to the unbounded encoding', () => {
  const outcome = {
    status: 'partially landed',
    code: 'catalog_partial',
    reason: 'Dropped fields: description',
  };
  const { header, omitted } = encodeExtensionResponses(outcome);

  assert.equal(omitted, null, 'nothing needed to be omitted');
  // This is the property the #368 laziness test depends on: the bounding must
  // not perturb the bytes of an envelope that fits.
  assert.equal(header, Buffer.from(JSON.stringify({ bazaar: outcome })).toString('base64'));
  assert.deepEqual(decode(header), { bazaar: outcome });
});

test('Every header value fits the cap, for adversarial inputs', () => {
  const outcomes = [
    { status: 'landed', code: 'catalog_success' },
    { status: 'partially landed', code: 'catalog_partial', reason: 'x'.repeat(10_000) },
    { status: 'rejected', code: 'catalog_rate_limited', reason: 'y'.repeat(1_000_000) },
    {
      status: 'rejected',
      code: 'z'.repeat(100_000),
      reason: 'r'.repeat(100_000),
      detail: 'd'.repeat(100_000),
    },
  ];

  for (const outcome of outcomes) {
    const { header } = encodeExtensionResponses(outcome);
    assert.ok(
      header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES,
      `header of ${header.length} bytes exceeds the ${MAX_EXTENSION_RESPONSES_HEADER_BYTES} cap`,
    );
    // A bounded header is useless if it is not still a parseable envelope.
    assert.doesNotThrow(() => decode(header), 'the bounded header must remain valid base64 JSON');
  }
});

test('An oversized envelope drops only `reason`, keeping the structure', () => {
  const outcome = {
    status: 'rejected',
    code: 'catalog_rate_limited',
    reason: 'r'.repeat(10_000),
  };
  const { header, omitted } = encodeExtensionResponses(outcome);

  assert.equal(omitted, 'reason');
  const envelope = decode(header).bazaar;
  assert.equal(envelope.status, 'rejected', 'the status a client acts on survives');
  assert.equal(envelope.code, 'catalog_rate_limited');
  assert.equal(envelope.detail_omitted, true);
  assert.equal(envelope.reason, undefined, 'the free-text field is the one that goes');
});

test('An envelope too large even without `reason` degrades to a minimal status envelope', () => {
  const outcome = {
    status: 'rejected',
    code: 'c'.repeat(100_000),
    reason: 'r'.repeat(100_000),
  };
  const { header, omitted } = encodeExtensionResponses(outcome);

  assert.equal(omitted, 'all');
  const envelope = decode(header).bazaar;
  assert.equal(envelope.status, 'rejected');
  assert.equal(envelope.code, OMITTED_CODE);
  assert.equal(envelope.detail_omitted, true);
});

test('The minimal envelope is small enough that no input can defeat it', () => {
  // The tier-3 payload has no variable-length field, so its size is a
  // constant. If it ever exceeded the cap the bounding would be a lie.
  const { header } = encodeExtensionResponses({
    status: 'rejected',
    code: 'c'.repeat(1_000_000),
  });
  assert.ok(header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES);
});

test('A non-object outcome reports "not attempted" instead of encoding `{bazaar: null}`', () => {
  for (const outcome of [null, undefined, 'landed', 42, []]) {
    const { header, omitted } = encodeExtensionResponses(outcome);
    const envelope = decode(header).bazaar;
    assert.deepEqual(
      envelope,
      { status: 'not attempted' },
      `${JSON.stringify(outcome)} must not produce a bare null envelope`,
    );
    assert.equal(omitted, 'all');
  }
});

test('An unrecognised status in the minimal envelope is normalised, not passed through', () => {
  const { header } = encodeExtensionResponses({
    status: 'teapot',
    code: 'c'.repeat(100_000),
  });
  const envelope = decode(header).bazaar;
  assert.ok(
    KNOWN_STATUSES.includes(envelope.status),
    `degraded status must be one the contract defines, got ${envelope.status}`,
  );
  assert.equal(envelope.status, 'not attempted');
});

test('Every degraded envelope is still one the client can act on', () => {
  // The point of degrading rather than failing: whatever tier we land in, the
  // status must be present and from the declared set.
  for (const outcome of [
    { status: 'landed', code: 'x'.repeat(100_000) },
    { status: 'partially landed', code: 'x'.repeat(100_000) },
    { status: 'rejected', reason: 'r'.repeat(100_000), code: 'x'.repeat(100_000) },
  ]) {
    const envelope = decode(encodeExtensionResponses(outcome).header).bazaar;
    assert.ok(
      KNOWN_STATUSES.includes(envelope.status),
      `status ${envelope.status} is not one the envelope contract defines`,
    );
  }
});
