/**
 * The EXTENSION-RESPONSES header must stay bounded (#202).
 *
 * The header is the only channel a seller has to learn what the Bazaar did, so
 * an envelope an intermediary rejects or truncates is worse than a short one —
 * truncated base64 does not decode at all, and the seller is left with no
 * outcome. Every value in the envelope is drawn from a fixed vocabulary today,
 * which makes it small by accident; these tests assert it is small by
 * construction, including for an outcome carrying fields that do not exist yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeExtensionResponses,
  MAX_EXTENSION_RESPONSES_HEADER_BYTES,
  KNOWN_STATUSES,
  OMITTED_CODE,
} from '../src/catalog/extension-responses.js';

/** Decodes a header value back into the envelope a seller would see. */
function decode(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

test('a healthy envelope is sent whole and well under the cap', () => {
  const outcome = {
    status: 'partially landed',
    code: 'catalog_partial',
    reason: 'Dropped fields: iconUrl, description',
  };
  const { header, omitted } = encodeExtensionResponses(outcome);

  assert.equal(omitted, null);
  assert.deepEqual(decode(header).bazaar, outcome);
  assert.ok(header.length < 200, `expected a small envelope, got ${header.length} bytes`);
});

test('oversized free text is shed rather than sent, and flagged', () => {
  const outcome = {
    status: 'rejected',
    code: 'catalog_partial',
    reason: `Dropped fields: ${'x'.repeat(20_000)}`,
  };
  const { header, omitted } = encodeExtensionResponses(outcome);

  assert.ok(
    header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES,
    `header was ${header.length} bytes, cap is ${MAX_EXTENSION_RESPONSES_HEADER_BYTES}`,
  );
  assert.equal(omitted, 'reason');
  const { bazaar } = decode(header);
  // The actionable parts survive: the seller still learns what happened.
  assert.equal(bazaar.status, 'rejected');
  assert.equal(bazaar.code, 'catalog_partial');
  assert.equal(bazaar.detail_omitted, true);
  assert.equal(bazaar.reason, undefined);
});

test('an outcome that cannot be trimmed still yields a decodable header', () => {
  // Fields the cataloging path does not set today, as a stand-in for a future
  // caller-derived one: the bound must hold regardless of what lands here.
  const outcome = {
    status: 'landed',
    code: 'catalog_success',
    reason: 'y'.repeat(20_000),
    diagnostics: 'z'.repeat(20_000),
    echoedUrl: `https://example.com/${'w'.repeat(20_000)}`,
  };
  const { header, omitted } = encodeExtensionResponses(outcome);

  assert.ok(header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES);
  assert.equal(omitted, 'all');
  const { bazaar } = decode(header);
  assert.equal(bazaar.status, 'landed', 'status is ours and always carried through');
  assert.equal(bazaar.code, OMITTED_CODE);
  assert.equal(bazaar.detail_omitted, true);
});

test('a hostile status cannot grow the header', () => {
  const outcome = { status: 'q'.repeat(20_000), code: 'catalog_success' };
  const { header, omitted } = encodeExtensionResponses(outcome);

  assert.ok(header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES);
  assert.equal(omitted, 'all');
  // An unrecognised status is not echoed — only ours are.
  assert.equal(decode(header).bazaar.status, 'not attempted');
});

test('every status the envelope may carry is one the cataloging path emits', () => {
  assert.deepEqual(KNOWN_STATUSES, ['not attempted', 'landed', 'partially landed', 'rejected']);
});

test('the cap leaves room under the intermediaries this deploys behind', () => {
  // nginx defaults large_client_header_buffers to 8k and Node caps incoming
  // headers at 16 KiB; staying well below both is the point.
  assert.ok(MAX_EXTENSION_RESPONSES_HEADER_BYTES <= 4096);
});

test('a null outcome degrades to a valid envelope rather than throwing', () => {
  // The documented contract is `{ bazaar: { status, ... } }`, so a missing
  // outcome must not encode as `{ bazaar: null }`.
  const { header } = encodeExtensionResponses(null);
  assert.ok(header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES);
  assert.equal(decode(header).bazaar.status, 'not attempted');
});
