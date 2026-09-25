/**
 * The EXTENSION-RESPONSES envelope, bounded (#202).
 *
 * The header is the only channel a seller has to learn what the Bazaar did with
 * their resource, so it is base64-encoded JSON: `{ bazaar: { status, ... } }`.
 * Nothing bounded its size. Every value in it happens to come from a fixed
 * vocabulary today — the four statuses, the `catalog_*` codes, and a list of
 * literal field names — so the envelope is small *by accident*, not by
 * construction, and nothing asserted it.
 *
 * The failure mode is worse than a missing header. `processCataloging` has a
 * deliberate fallback so a malformed extension still surfaces an explicit
 * outcome rather than omitting the header; an oversized header defeats that
 * fallback, because intermediaries reject or truncate past roughly 8 KiB and a
 * truncated base64 blob does not decode at all. The seller would then get
 * nothing — exactly the outcome the fallback exists to prevent.
 *
 * So the size is enforced here, at the one place the envelope is built, with
 * degradation that keeps the header decodable:
 *
 *   1. the full envelope, when it fits;
 *   2. without `reason` (the only free-text field) and marked `detail_omitted`;
 *   3. `status` and `code` alone, both validated against their vocabularies.
 *
 * A caller-derived field added to `outcome` in future is therefore bounded
 * automatically: it can push the envelope to tier 2 or 3, but never past the
 * cap. `encodeExtensionResponses` reports which tier answered so the caller can
 * log the loss of detail rather than let it happen silently.
 */

/**
 * Cap on the encoded header value, in bytes.
 *
 * Conservative on purpose. Node accepts 16 KiB of incoming headers by default,
 * and the proxies this is deployed behind are commonly stricter still (nginx's
 * `large_client_header_buffers` defaults to 8k). A healthy envelope is well
 * under 200 bytes, so there is no pressure to spend more of it.
 */
export const MAX_EXTENSION_RESPONSES_HEADER_BYTES = 4096;

/** Statuses the envelope may carry. Anything else is not ours to report. */
export const KNOWN_STATUSES = ['not attempted', 'landed', 'partially landed', 'rejected'];

/** Emitted at tier 3, when even the status could not be carried through. */
export const OMITTED_CODE = 'extension_response_omitted';

/**
 * Encodes a cataloging outcome as an EXTENSION-RESPONSES header value.
 *
 * @param {object|null|undefined} outcome
 * @returns {{header: string, omitted: null|'reason'|'all'}}
 *   `header` is the base64 value to send, never longer than
 *   {@link MAX_EXTENSION_RESPONSES_HEADER_BYTES}. `omitted` is null when the
 *   whole outcome was sent, `'reason'` when free text was shed to fit, and
 *   `'all'` when only the status/code pair survived.
 */
export function encodeExtensionResponses(outcome) {
  const encode = value => Buffer.from(JSON.stringify({ bazaar: value })).toString('base64');
  const fits = header => header.length <= MAX_EXTENSION_RESPONSES_HEADER_BYTES;

  // Every envelope must decode to `{ bazaar: { status, ... } }`, so a missing or
  // non-object outcome becomes the minimal envelope rather than `{ bazaar: null }`.
  if (outcome === null || typeof outcome !== 'object') {
    return { header: encode({ status: 'not attempted' }), omitted: 'all' };
  }

  const full = encode(outcome);
  if (fits(full)) return { header: full, omitted: null };

  // `reason` is the only field carrying free text, so it is the first to go.
  const { reason: _reason, ...rest } = outcome;
  const withoutReason = encode({ ...rest, detail_omitted: true });
  if (fits(withoutReason)) return { header: withoutReason, omitted: 'reason' };

  // Whatever is left is not something we put there. Carry the status if it is
  // one of ours, so a seller still learns whether their listing landed.
  const status = KNOWN_STATUSES.includes(outcome.status) ? outcome.status : 'not attempted';
  return {
    header: encode({ status, code: OMITTED_CODE, detail_omitted: true }),
    omitted: 'all',
  };
}
