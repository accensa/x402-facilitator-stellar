/**
 * Bounded encoding of the `EXTENSION-RESPONSES` response header (#202).
 *
 * Every catalogable verify/settle answers with a base64 `{bazaar: {...}}`
 * envelope describing what the catalog did with the resource. The envelope is
 * assembled from values the *caller* controls — a rate-limit reason, a list of
 * dropped field names, and whatever a future outcome field carries — and was
 * encoded with no size limit at all.
 *
 * Response headers are not free-form transport. Proxies, CDNs and load
 * balancers cap header size (nginx defaults to 8 KiB for the whole request
 * line + headers; Envoy defaults to 60 KiB; HTTP/2 implementations commonly
 * enforce 16 KiB), and when the cap is exceeded the failure is not a truncated
 * header — it is a **502 or a dropped connection**, on the payment path, for a
 * payment that already settled. The buyer's money moves and the response that
 * would have explained it never arrives.
 *
 * So the envelope is bounded and degrades in tiers, each one still a valid
 * envelope that a client can parse:
 *
 * 1. The full envelope, when it fits.
 * 2. The envelope without `reason` (the long free-text field), marked
 *    `detail_omitted: true`.
 * 3. A minimal `{status, code, detail_omitted}` envelope.
 *
 * The status is always preserved — a client learning "rejected" without
 * learning why is a far better outcome than a client learning nothing.
 */

/**
 * Cap on the encoded header value in bytes. The limit applies to the base64
 * text (what actually goes on the wire), not to the JSON it encodes, because
 * the base64 expansion is what the proxy counts.
 *
 * 4096 is deliberately conservative: it leaves room for the rest of the
 * response's headers inside an 8 KiB total budget, and it is small enough that
 * the tier-3 envelope always fits regardless of how long the inputs were.
 */
export const MAX_EXTENSION_RESPONSES_HEADER_BYTES = 4096;

/** Statuses the envelope contract defines. An unrecognised one is degraded. */
export const KNOWN_STATUSES = ['not attempted', 'landed', 'partially landed', 'rejected'];

/** Code reported in place of detail that could not be carried. */
export const OMITTED_CODE = 'extension_response_omitted';

function encode(payload) {
  return Buffer.from(JSON.stringify({ bazaar: payload })).toString('base64');
}

/**
 * Encodes a catalog outcome into a bounded EXTENSION-RESPONSES header value.
 *
 * @param {object|null} outcome the settled catalog outcome
 * @returns {{header: string, omitted: 'reason'|'all'|null}} the encoded value
 *   and what was dropped to make it fit (`null` when nothing was), so the
 *   caller can log the degradation instead of silently shipping less.
 */
export function encodeExtensionResponses(outcome) {
  const fits = header => header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES;

  // A null/non-object outcome would encode as `{bazaar: null}`, which is not
  // the documented envelope shape. Report it as "not attempted" rather than
  // emitting something a client cannot read.
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) {
    return { header: encode({ status: 'not attempted' }), omitted: 'all' };
  }

  // Tier 1: the envelope as-is. This is the path every ordinary response takes
  // and it is byte-identical to the unbounded encoding it replaces.
  const full = encode(outcome);
  if (fits(full)) return { header: full, omitted: null };

  // Tier 2: drop the free-text detail, keep everything structural. `reason` is
  // the only field whose length is not bounded by the outcome contract.
  const { reason: _reason, ...rest } = outcome;
  const withoutReason = encode({ ...rest, detail_omitted: true });
  if (fits(withoutReason)) return { header: withoutReason, omitted: 'reason' };

  // Tier 3: even the structural fields did not fit (a caller-controlled field
  // other than `reason` was enormous). Keep the status, which is the part a
  // client acts on, and say plainly that the rest was omitted.
  const status = KNOWN_STATUSES.includes(outcome.status) ? outcome.status : 'not attempted';
  return { header: encode({ status, code: OMITTED_CODE, detail_omitted: true }), omitted: 'all' };
}
