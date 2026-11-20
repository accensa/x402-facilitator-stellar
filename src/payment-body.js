/**
 * Request body validation, schema definitions, and payload extraction for payment and discovery routes.
 */
import { validatePaymentBody, validatePaymentFields } from './request-validation.js';

/** 256kb body cap, carried over unchanged from the Express transport. */
export const BODY_LIMIT_BYTES = 256 * 1024;

/**
 * AJV schema for both payment routes.
 *
 * Only the transport-owned fields are bounded (#676). The body cap is 256 KB,
 * so without these a request of unknown keys would pass AJV and be handed to
 * the scheme. `additionalProperties: false` is top-level only: a scheme's
 * `paymentRequirements.extra` and the payload inside `paymentPayload` are the
 * scheme's contract, and rejecting a field the scheme accepts would be a
 * conformance failure (src/request-validation.js).
 *
 * Bounds, and why they are loose rather than tight: `scheme` is a short name
 * (`exact`, `pact`); `network` is a CAIP-2 id, and 64 matches the ceiling
 * already used for network elsewhere in the HTTP surface. `paymentPayload`
 * carries x402Version, scheme, network, payload plus optional resource and
 * extensions (6 in the catalogable fixture); `paymentRequirements` carries the
 * core requirement fields plus scheme-specific extras. Both leave room for
 * future optional fields while still bounding a body made only of junk keys.
 *
 * `x402Version` is the one other top-level key the wire format defines
 * (`VerifyRequest` in @x402/core), so it is listed rather than rejected; the
 * transport does not read it, and the minimum keeps a nonsense value out.
 */
export const PAYMENT_BODY_SCHEMA = {
  type: 'object',
  required: ['paymentPayload', 'paymentRequirements'],
  additionalProperties: false,
  properties: {
    x402Version: { type: 'integer', minimum: 1 },
    paymentPayload: { type: 'object', maxProperties: 16 },
    paymentRequirements: {
      type: 'object',
      maxProperties: 32,
      required: ['scheme', 'network'],
      properties: {
        scheme: { type: 'string', minLength: 1, maxLength: 32 },
        network: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
  },
};

/**
 * Reads and validates payment request body for /verify and /settle.
 *
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @param {object} config
 * @param {'verify'|'settle'} route
 * @returns {{ paymentPayload: object, paymentRequirements: object } | null}
 */
export function readPaymentBody(req, reply, config, route) {
  if (route !== 'verify' && route !== 'settle') {
    throw new TypeError(
      `readPaymentBody: route must be 'verify' or 'settle', received ${JSON.stringify(route)}`,
    );
  }

  let result;
  if (req.validationError) {
    const detail = Array.isArray(req.validationError.validation)
      ? req.validationError.validation[0]
      : undefined;
    result = {
      valid: false,
      reason: 'invalid_request',
      message: detail?.message
        ? `${detail.instancePath ?? detail.params?.missingProperty ?? 'body'} ${detail.message}`.trim()
        : (req.validationError.message ?? 'invalid request body'),
    };
  } else {
    result = validatePaymentBody(req.body, config);
  }

  if (!result.valid) {
    if (route === 'settle') {
      const net = req.body?.paymentRequirements?.network;
      const body = {
        success: false,
        errorReason: result.reason,
        errorMessage: result.message,
        transaction: '',
      };
      if (typeof net === 'string' && net.length <= 64) {
        body.network = net;
      }
      reply.code(400).send(body);
    } else {
      reply.code(400).send({
        isValid: false,
        invalidReason: result.reason,
        invalidMessage: result.message,
      });
    }
    return null;
  }
  return {
    paymentPayload: result.paymentPayload,
    paymentRequirements: result.paymentRequirements,
  };
}

/**
 * Extracts and validates resource submission body for manual discovery registration.
 *
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @returns {{ paymentPayload: object, paymentRequirements: object } | null}
 */
export function readDiscoveryBody(req, reply) {
  let result;
  if (req.validationError) {
    const detail = Array.isArray(req.validationError.validation)
      ? req.validationError.validation[0]
      : undefined;
    result = {
      valid: false,
      reason: 'invalid_request',
      message: detail?.message
        ? `${detail.instancePath ?? detail.params?.missingProperty ?? 'body'} ${detail.message}`.trim()
        : (req.validationError.message ?? 'invalid request body'),
    };
  } else {
    result = validatePaymentFields(req.body);
  }

  if (!result.valid) {
    reply.code(400).send({
      error: 'invalid_resource',
      reason: result.reason,
    });
    return null;
  }
  return {
    paymentPayload: result.paymentPayload,
    paymentRequirements: result.paymentRequirements,
  };
}
