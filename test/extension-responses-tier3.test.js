/**
 * @description The minimal tier-3 EXTENSION-RESPONSES envelope (#685).
 *
 * Tier 3 is the last thing a buyer is told after settlement when even the
 * degraded envelope cannot fit the header cap. These tests pin, for every
 * known status, the exact key set and status of that envelope when the field
 * that overflows is the one the envelope really carries (`truncated`), and
 * locate the tier-2/tier-3 boundary by search rather than a hard-coded size.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeExtensionResponses,
  MAX_EXTENSION_RESPONSES_HEADER_BYTES,
  KNOWN_STATUSES,
  OMITTED_CODE,
} from '../src/catalog/extension-responses.js';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TIER3_KEYS = ['code', 'detail_omitted', 'status'];

function decode(header) {
  assert.match(header, BASE64, 'header must be valid base64');
  assert.equal(header.length % 4, 0, 'header must be padded base64');
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

/** An oversized `truncated` array, shaped like `outcome.truncated` in app.js. */
function oversizedTruncated(marker) {
  return Array.from({ length: 2_000 }, (_, i) => `${marker}_${i}`);
}

for (const status of KNOWN_STATUSES) {
  test(`tier 3 keeps "${status}" and carries exactly {status, code, detail_omitted}`, () => {
    const marker = 'oversized_field_marker';
    const outcome = {
      status,
      code: 'catalog_partial',
      reason: 'Dropped fields: ' + 'description, '.repeat(500),
      truncated: oversizedTruncated(marker),
    };
    const { header, omitted } = encodeExtensionResponses(outcome);

    assert.equal(omitted, 'all');
    assert.ok(header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES);

    const envelope = decode(header);
    assert.deepEqual(Object.keys(envelope), ['bazaar']);
    assert.deepEqual(Object.keys(envelope.bazaar).sort(), TIER3_KEYS);
    assert.deepEqual(envelope.bazaar, { status, code: OMITTED_CODE, detail_omitted: true });

    // Nothing the caller sent in the oversized field survives anywhere.
    const text = Buffer.from(header, 'base64').toString('utf8');
    assert.ok(!text.includes(marker), 'oversized field contents must not leak');
    assert.ok(!text.includes('truncated'), 'oversized field name must not leak');
    assert.ok(!text.includes('Dropped fields'), 'reason must not leak');
  });
}

test('tier 3 degrades an unrecognised status to "not attempted"', () => {
  const { header, omitted } = encodeExtensionResponses({
    status: 'teapot',
    code: 'catalog_partial',
    truncated: oversizedTruncated('x'),
  });
  assert.equal(omitted, 'all');
  assert.deepEqual(decode(header).bazaar, {
    status: 'not attempted',
    code: OMITTED_CODE,
    detail_omitted: true,
  });
});

test('boundary sweep: tier 2 holds until the structural fields overflow, then tier 3', t => {
  for (const status of KNOWN_STATUSES) {
    const outcomeOf = n => ({
      status,
      code: 'catalog_partial',
      reason: 'r'.repeat(5_000), // always forces past tier 1
      truncated: ['x'.repeat(n)],
    });

    // Grow n until the tier flips; the step is 1 so the pair is adjacent.
    let lastTier2 = null;
    let firstTier3 = null;
    for (let n = 0; n <= MAX_EXTENSION_RESPONSES_HEADER_BYTES; n++) {
      const { header, omitted } = encodeExtensionResponses(outcomeOf(n));
      assert.ok(
        header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES,
        `n=${n}: header of ${header.length} bytes exceeds the cap`,
      );
      decode(header);
      if (omitted === 'reason') {
        assert.equal(firstTier3, null, `n=${n}: tier 2 reappeared after tier 3`);
        lastTier2 = { n, bytes: header.length };
      } else {
        assert.equal(omitted, 'all', `n=${n}: unexpected tier ${omitted}`);
        if (firstTier3 === null) firstTier3 = { n, bytes: header.length };
      }
    }

    assert.ok(lastTier2, `${status}: tier 2 was never reached`);
    assert.ok(firstTier3, `${status}: tier 3 was never reached`);
    assert.equal(firstTier3.n, lastTier2.n + 1, `${status}: the flip must be adjacent`);

    // The last tier-2 input is the largest one that fits; the next input
    // would have produced an over-cap tier-2 header.
    assert.ok(lastTier2.bytes <= MAX_EXTENSION_RESPONSES_HEADER_BYTES);
    const { reason: _r, ...rest } = outcomeOf(firstTier3.n);
    const overCap = Buffer.from(
      JSON.stringify({ bazaar: { ...rest, detail_omitted: true } }),
    ).toString('base64');
    assert.ok(overCap.length > MAX_EXTENSION_RESPONSES_HEADER_BYTES);

    // Tier 2 at the edge still carries the structural fields and status.
    const edge = decode(encodeExtensionResponses(outcomeOf(lastTier2.n)).header).bazaar;
    assert.equal(edge.status, status);
    assert.equal(edge.truncated[0].length, lastTier2.n);
    assert.equal(edge.reason, undefined);

    // Tier 3 just past the edge keeps the status too.
    const past = decode(encodeExtensionResponses(outcomeOf(firstTier3.n)).header).bazaar;
    assert.deepEqual(past, { status, code: OMITTED_CODE, detail_omitted: true });

    t.diagnostic(
      `${status}: last tier-2 n=${lastTier2.n} (${lastTier2.bytes} B), first tier-3 n=${firstTier3.n} (${firstTier3.bytes} B)`,
    );
  }
});
