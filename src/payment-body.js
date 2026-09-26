/**
 * Request body validation, schema definitions, and payload extraction for payment and discovery routes.
 */
import { validatePaymentBody, validatePaymentFields } from './request-validation.js';

/** 256kb body cap, carried over unchanged from the Express transport. */
export const BODY_LIMIT_BYTES = 256 * 1024;

/**
 * AJV schema for both payment routes.
 */
export const PAYMENT_BODY_SCHEMA = {
  type: 'object',
  required: ['paymentPayload', 'paymentRequirements'],
  properties: {
    paymentPayload: { type: 'object' },
    paymentRequirements: {
      type: 'object',
      required: ['scheme', 'network'],
      properties: {
        scheme: { type: 'string', minLength: 1 },
        network: { type: 'string', minLength: 1 },
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
 * @param {'verify'|'settle'} [route='verify']
 * @returns {{ paymentPayload: object, paymentRequirements: object } | null}
 */
export function readPaymentBody(req, reply, config, route = 'verify') {
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
      reply.code(400).send({
        success: false,
        errorReason: result.reason,
        errorMessage: result.message,
        transaction: '',
        network: req.body?.paymentRequirements?.network,
      });
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
