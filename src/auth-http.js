import { createRemoteJWKSet, jwtVerify } from 'jose';

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
const jwksInFlight = new Map();

export function createJwtVerifier(jwksUri, options = {}) {
  const { issuer = null, audience = null, clockTolerance = 30, requiredScopes = [] } = options;

  async function verifyToken(token) {
    let jwks = jwksCache.get(jwksUri);

    if (!jwks) {
      let fetchPromise = jwksInFlight.get(jwksUri);
      if (!fetchPromise) {
        fetchPromise = Promise.resolve().then(() => {
          const jwksResult = createRemoteJWKSet(new URL(jwksUri), {
            cacheMaxAge: JWKS_CACHE_TTL_MS,
            cooldownDuration: JWKS_CACHE_TTL_MS,
          });
          jwksCache.set(jwksUri, jwksResult);
          return jwksResult;
        });
        jwksInFlight.set(jwksUri, fetchPromise);
      }

      try {
        jwks = await fetchPromise;
      } finally {
        if (jwksInFlight.get(jwksUri) === fetchPromise) {
          jwksInFlight.delete(jwksUri);
        }
      }
    }

    const verifyOptions = { clockTolerance };
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
