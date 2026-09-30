/**
 * CORS handling (#76).
 *
 * Policies are decided per route class rather than globally:
 *   - Public reads (/supported, GET /discovery/resources, /discovery/search) default
 *     to '*' when no origins are configured, and narrow to allowed origins when set.
 *   - Authenticated payment routes (/verify, /settle, /usage, POST /discovery/resources)
 *     never default open: origins must be explicitly allowlisted in CORS_ALLOWED_ORIGINS.
 */

// Headers a browser client must be able to read but which are not
// CORS-safelisted response headers.
export const EXPOSED_HEADERS = [
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
  'EXTENSION-RESPONSES',
].join(', ');

/**
 * Creates a Fastify `onRequest` hook enforcing route-class CORS policies.
 *
 * @param {object} [corsConfig={}]
 * @param {string[]} [corsConfig.allowedOrigins=[]]
 * @returns {(policy: 'public' | 'authenticated') => (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>}
 */
export function createCorsHook(corsConfig = {}) {
  const allowedOrigins = corsConfig.allowedOrigins ?? [];
  return function cors(policy) {
    return async (req, reply) => {
      reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);

      const origin = req.headers.origin;
      const allowlisted = origin && allowedOrigins.includes(origin);
      let granted;
      if (policy === 'public') {
        granted = allowlisted ? origin : allowedOrigins.length === 0 ? '*' : false;
      } else {
        // Never default-open anything authenticated.
        granted = allowlisted ? origin : false;
      }

      reply.header('Vary', 'Origin');

      if (granted) {
        reply.header('Access-Control-Allow-Origin', granted);
      }
    };
  };
}

/**
 * Creates an OPTIONS preflight route handler for a given route class policy.
 *
 * @param {object} [corsConfig={}]
 * @param {string[]} [corsConfig.allowedOrigins=[]]
 * @returns {(policy: 'public' | 'authenticated') => (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>}
 */
export function createPreflightHandler(corsConfig = {}) {
  const cors = createCorsHook(corsConfig);
  return function preflight(policy) {
    return async (req, reply) => {
      await cors(policy)(req, reply);
      reply.header(
        'Access-Control-Allow-Methods',
        policy === 'public' ? 'GET, OPTIONS' : 'POST, OPTIONS',
      );
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      reply.header('Access-Control-Max-Age', '600');
      return reply.code(204).send();
    };
  };
}
