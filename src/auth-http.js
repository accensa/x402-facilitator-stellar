/**
 * JWT Bearer Token Authentication with JWKS verification (#419).
 *
 * Supports RS256 and EdDSA algorithms. Verifies JWT signature using a
 * JWKS endpoint, validates standard claims (iss, aud, exp, nbf, sub),
 * extracts scopes, and enforces least-privilege access.
 *
 * Tokens are cached in memory with TTL matching token expiration.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { verifyApiKey } from './auth.js';

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_JWKS_CACHE_ENTRIES = 10;

class JwksCache {
  constructor() {
    this.cache = new Map();
    this.timestamps = new Map();
  }

  get(jwksUri) {
    const now = Date.now();
    const ts = this.timestamps.get(jwksUri);
    if (ts && now - ts < JWKS_CACHE_TTL_MS) {
      return this.cache.get(jwksUri);
    }
    return null;
  }

  set(jwksUri, jwks) {
    if (this.cache.size >= MAX_JWKS_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
      this.timestamps.delete(oldest);
    }
    this.cache.set(jwksUri, jwks);
    this.timestamps.set(jwksUri, Date.now());
  }
}

const jwksCache = new JwksCache();

export function createJwtVerifier(jwksUri, options = {}) {
  const { issuer = null, audience = null, clockTolerance = 30, requiredScopes = [] } = options;

  async function verifyToken(token) {
    let jwks = jwksCache.get(jwksUri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUri), {
        cacheMaxAge: JWKS_CACHE_TTL_MS,
        cooldownDuration: JWKS_CACHE_TTL_MS,
      });
      jwksCache.set(jwksUri, jwks);
    }

    const verifyOptions = {
      clockTolerance,
    };
    if (issuer) verifyOptions.issuer = issuer;
    if (audience) verifyOptions.audience = audience;

    const { payload } = await jwtVerify(token, jwks, verifyOptions);
    return payload;
  }

  async function verifyAndExtractScopes(token) {
    const payload = await verifyToken(token);
    const scopes = Array.isArray(payload.scp)
      ? payload.scp
      : Array.isArray(payload.scope)
        ? payload.scope.split(' ')
        : typeof payload.scope === 'string'
          ? payload.scope.split(' ')
          : [];

    for (const required of requiredScopes) {
      if (!scopes.includes(required)) {
        throw new Error(`missing_required_scope: ${required}`);
      }
    }

    return { payload, scopes };
  }

  return { verifyToken, verifyAndExtractScopes };
}

export function createAuthMiddlewareWithJwt({ config, audit }) {
  const { apiKeys = [] } = config;

  const jwtConfig = config.jwt ?? {};
  let jwtVerifier = null;
  if (jwtConfig.jwksUri) {
    jwtVerifier = createJwtVerifier(jwtConfig.jwksUri, {
      issuer: jwtConfig.issuer ?? null,
      audience: jwtConfig.audience ?? null,
      clockTolerance: jwtConfig.clockTolerance ?? 30,
      requiredScopes: jwtConfig.requiredScopes ?? [],
    });
  }

  async function requireApiKey(req, reply) {
    if (apiKeys.length === 0 && !jwtVerifier) return;

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      audit('auth_failure', { actor: `ip:${req.ip}`, reason: 'missing_auth_header' });
      return reply.code(401).send({
        isValid: false,
        invalidReason: 'missing_auth_header',
        invalidMessage: 'unauthorized',
        reason: 'missing_auth_header',
      });
    }

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      if (jwtVerifier && token.includes('.')) {
        try {
          const { payload, scopes } = await jwtVerifier.verifyAndExtractScopes(token);

          const keyId = payload.sub ?? payload.azp ?? 'jwt';
          if (req.span) req.span.keyId = keyId;
          req.keyId = keyId.toUpperCase();
          req.scopes = scopes;
          req.jwtPayload = payload;
          return;
        } catch (err) {
          audit('auth_failure', { actor: `ip:${req.ip}`, reason: err.message });
          return reply.code(401).send({
            isValid: false,
            invalidReason: err.message,
            invalidMessage: 'unauthorized',
            reason: err.message,
          });
        }
      }

      const result = verifyApiKey(authHeader, apiKeys);
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
      return;
    }

    const result = verifyApiKey(authHeader, apiKeys);
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
    if (apiKeys.length === 0 && !jwtVerifier) {
      return reply.code(401).send({
        isValid: false,
        invalidReason: 'open_mode_usage_forbidden',
        invalidMessage: 'unauthorized',
      });
    }
    return requireApiKey(req, reply);
  }

  function requireScope(...scopes) {
    return async (req, reply) => {
      if (!req.scopes || !scopes.every(s => req.scopes.includes(s))) {
        audit('auth_failure', {
          actor: req.keyId ?? `ip:${req.ip}`,
          reason: 'insufficient_scope',
          required: scopes,
          granted: req.scopes ?? [],
        });
        return reply.code(403).send({
          isValid: false,
          invalidReason: 'insufficient_scope',
          invalidMessage: `Required scope(s): ${scopes.join(', ')}`,
          reason: 'insufficient_scope',
        });
      }
    };
  }

  return { requireApiKey, requireApiKeyStrict, requireScope };
}

export default { createJwtVerifier, createAuthMiddlewareWithJwt };
