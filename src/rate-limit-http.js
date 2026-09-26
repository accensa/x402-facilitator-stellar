/**
 * HTTP Rate Limit header formatting and rejection helpers (#11, #209).
 *
 * Provides RFC-compliant RateLimit-* and Retry-After response headers and
 * standard 429 JSON response generation.
 */

/**
 * The ONE place RateLimit-* headers are written and the ONE place a 429 is
 * sent (#209).
 *
 * `states` are candidate limiter states in preference order. The first one
 * with a finite `remaining` wins, which is the post-record state when the
 * limiter returns one (#141: it reflects this request already counted) and
 * the pre-record check when it does not (a limiter whose record call returns
 * nothing). A state that is itself null is skipped, so passing both is safe.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {...(object|null)} states
 * @returns {object|null} the reply when this call answered (a 429 was sent),
 *   null when the caller may continue.
 */
export function handleRateLimit(reply, ...states) {
  const state =
    states.find(candidate => candidate && Number.isFinite(candidate.remaining)) ??
    states.find(candidate => candidate != null) ??
    null;
  if (!state) return null;

  reply.header('RateLimit-Limit', state.limit);
  reply.header('RateLimit-Remaining', state.remaining);
  reply.header('RateLimit-Reset', state.resetAt);

  if (!state.allowed) {
    reply.header('Retry-After', Math.max(1, state.resetAt - Math.floor(Date.now() / 1000)));
    return reply.code(429).send({
      isValid: false,
      invalidReason: 'rate_limited',
      invalidMessage: state.reason,
      reason: state.reason,
    });
  }
  return null;
}

/**
 * Audits rate-limit rejections as abuse signals and responds with 429.
 *
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @param {string} route
 * @param {{ limit: number, remaining: number, resetAt: number, allowed: boolean, reason?: string }} checkResult
 * @param {Function} audit
 * @param {object} [extra={}]
 * @returns {import('fastify').FastifyReply}
 */
export function rejectRateLimited(req, reply, route, checkResult, audit, extra = {}) {
  audit('rate_limit_rejected', {
    actor: req.keyId ?? `ip:${req.ip}`,
    route,
    reason: checkResult.reason,
    ...extra,
  });
  return handleRateLimit(reply, checkResult);
}
