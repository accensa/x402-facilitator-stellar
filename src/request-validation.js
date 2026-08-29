/**
 * Transport-layer validation for the /verify and /settle request bodies.
 *
 * The house rule for this repo is that verify/settle semantics live upstream
 * in @x402/stellar — we do not reimplement them. This module validates only
 * the structure the transport itself depends on before handing a body to the
 * scheme: that paymentPayload and paymentRequirements are present objects,
 * and that the fields the transport branches on (network, scheme) are the
 * type and value it expects.
 *
 * It deliberately does NOT validate paymentPayload.payload — the transaction
 * XDR, its signatures, operations, or amounts. That is the scheme's contract,
 * not the transport's, and a check here strict enough to reject a payload
 * the scheme would have accepted is a conformance failure, not a hardening
 * win. When in doubt, this lets it through and lets the scheme judge it.
 *
 * Hand-written rather than zod/ajv: this is five fields, and the repo is
 * deliberate about its dependency surface (see the licence-check job in CI).
 * A dependency is proportionate to a schema with nesting, refinement, unions,
 * or codegen needs; this has none of those. See #68.
 */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field, reason, message) {
  return { valid: false, field, reason, message };
}

/**
 * Validates that a body contains the required payment fields.
 * This is shared validation logic used by both payment routes and discovery routes.
 *
 * @param {unknown} body - the parsed JSON request body (req.body)
 * @returns {{valid: true, paymentPayload: object, paymentRequirements: object}
 *   | {valid: false, field: string, reason: string, message: string}}
 */
export function validatePaymentFields(body) {
  const { paymentPayload, paymentRequirements } = body ?? {};

  if (!isPlainObject(paymentPayload)) {
    return invalid('paymentPayload', 'invalid_request', 'paymentPayload must be an object');
  }
  if (!isPlainObject(paymentRequirements)) {
    return invalid(
      'paymentRequirements',
      'invalid_request',
      'paymentRequirements must be an object',
    );
  }
  if (typeof paymentRequirements.scheme !== 'string' || paymentRequirements.scheme === '') {
    return invalid(
      'paymentRequirements.scheme',
      'invalid_request',
      'paymentRequirements.scheme must be a non-empty string',
    );
  }
  if (typeof paymentRequirements.network !== 'string' || paymentRequirements.network === '') {
    return invalid(
      'paymentRequirements.network',
      'invalid_request',
      'paymentRequirements.network must be a non-empty string',
    );
  }

  return { valid: true, paymentPayload, paymentRequirements };
}

/**
 * @param {unknown} body - the parsed JSON request body (req.body)
 * @param {{networks: string[]}} config - resolved config; networks is the
 *   allowlist of CAIP-2 network identifiers this instance serves
 * @returns {{valid: true, paymentPayload: object, paymentRequirements: object}
 *   | {valid: false, field: string, reason: string, message: string}}
 */
export function validatePaymentBody(body, config) {
  const fieldValidation = validatePaymentFields(body);
  if (!fieldValidation.valid) {
    return fieldValidation;
  }

  // A distinct code from invalid_request: the body is well-formed, it just
  // names a network this instance does not serve. A client should be able to
  // branch on that rather than parse invalidMessage prose. Rejecting it here,
  // before the scheme sees it, matters because config.js keeps testnet and
  // pubnet signers rigidly separate — the failure mode of getting network
  // handling wrong on a pubnet instance is losing real money.
  if (!config.networks.includes(fieldValidation.paymentRequirements.network)) {
    return invalid(
      'paymentRequirements.network',
      'unsupported_network',
      `network "${fieldValidation.paymentRequirements.network}" is not served by this instance (serves: ${config.networks.join(', ')})`,
    );
  }

  return fieldValidation;
}
