/**
 * Caller authentication and API key validation (#206).
 *
 * Supports two Authorization header forms:
 *   1. `Authorization: Bearer <secret>`
 *   2. `Authorization: <secret>` (raw secret without scheme prefix)
 *
 * Comparisons use constant-time matching over SHA-256 digests. Key IDs are
 * normalized to uppercase and attached to req.keyId.
 */
import crypto from 'node:crypto';

/**
 * Extracts and verifies an API key from an Authorization header against configured keys.
 *
 * @param {string | undefined} authHeader
 * @param {Array<{ id: string, hash: Buffer }>} [apiKeys=[]]
 * @returns {{ valid: boolean, keyId?: string, reason?: string }}
 */
export function verifyApiKey(authHeader, apiKeys = []) {
  if (!authHeader) return { valid: false, reason: 'missing_auth_header' };
  if (authHeader === 'Bearer' || authHeader === 'Bearer ') {
    return { valid: false, reason: 'malformed_auth_header' };
  }

  let presentedKey = '';
  if (authHeader.startsWith('Bearer ')) {
    presentedKey = authHeader.substring(7);
  } else if (!authHeader.includes(' ')) {
    presentedKey = authHeader;
  } else {
    return { valid: false, reason: 'malformed_auth_header' };
  }

  if (!presentedKey || presentedKey.includes(' ')) {
    return { valid: false, reason: 'malformed_auth_header' };
  }

  const presentedHash = crypto.createHash('sha256').update(presentedKey).digest();

  for (const apiKey of apiKeys) {
    if (
      presentedHash.length === apiKey.hash.length &&
      crypto.timingSafeEqual(presentedHash, apiKey.hash)
    ) {
      return { valid: true, keyId: apiKey.id };
    }
  }

  return { valid: false, reason: 'invalid_api_key' };
}

/**
 * Creates authentication preHandlers for Fastify routes.
 *
 * @param {object} options
 * @param {object} options.config - Config with apiKeys array
 * @param {Function} options.audit - Audit logging function
 * @returns {{
 *   requireApiKey: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>,
 *   requireApiKeyStrict: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>,
 * }}
 */
export function createAuthMiddleware({ config, audit }) {
  const apiKeys = config?.apiKeys ?? [];

  async function requireApiKey(req, reply) {
    if (apiKeys.length === 0) return;

    const result = verifyApiKey(req.headers.authorization, apiKeys);
    if (!result.valid) {
      audit('auth_failure', { actor: `ip:${req.ip}`, reason: result.reason });
      return reply.code(401).send({
        isValid: false,
        invalidReason: result.reason,
        invalidMessage: 'unauthorized',
        reason: result.reason,
      });
    }

    if (req.span) req.span.keyId = result.keyId;
    req.keyId = result.keyId.toUpperCase();
  }

  async function requireApiKeyStrict(req, reply) {
    if (apiKeys.length === 0) {
      return reply.code(401).send({
        isValid: false,
        invalidReason: 'open_mode_usage_forbidden',
        invalidMessage: 'unauthorized',
      });
    }
    return requireApiKey(req, reply);
  }

  return { requireApiKey, requireApiKeyStrict };
}
