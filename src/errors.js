/**
 * Named custom errors for the public API surface.
 *
 * Downstream consumers import these instead of plumbing around plain
 * `Error` instances, so they can branch on the *kind* of failure instead of
 * comparing strings. The `code` is a stable wire secret for the entry shape
 * (`verify`/`settle`), while `message` is the human-readable detail.
 */

export class FacilitatorError extends Error {
  /** @type {string} stable reason code, e.g. `invalid_request` */
  code;
  /** @type {Record<string, unknown> | null} optional structured context */
  context = null;

  constructor(message, { code = 'facilitator_error', context = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
  }
}

export class InvalidRequestError extends FacilitatorError {
  constructor(message, context = null) {
    super(message, { code: 'invalid_request', context });
  }
}

export class NotFoundError extends FacilitatorError {
  constructor(message, context = null) {
    super(message, { code: 'not_found', context });
  }
}

export class UnauthorizedError extends FacilitatorError {
  constructor(message, context = null) {
    super(message, { code: 'invalid_api_key', context });
  }
}

export class RateLimitError extends FacilitatorError {
  constructor(message, context = null) {
    super(message, { code: 'rate_limited', context });
  }
}

export class ServiceUnavailableError extends FacilitatorError {
  constructor(message, context = null) {
    super(message, { code: 'settlement_store_unavailable', context });
  }
}

/** The default every internal failure maps to, so the caller always gets a reason. */
export function internalError(message, context = null) {
  return new FacilitatorError(message, { code: 'internal_error', context });
}

export const errors = {
  internalError,
  rateLimitError,
};

export function rateLimitError(message, context = null) {
  return new RateLimitError(message, context);
}
