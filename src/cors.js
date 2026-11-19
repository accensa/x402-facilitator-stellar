/**
 * CORS handling (#76).
 *
 * Policies are decided per route class rather than globally:
 *   - Public reads (/supported, GET /discovery/resources, /discovery/search) default
 *     to '*' when no origins are configured, and narrow to allowed origins when set.
 *   - Authenticated payment routes (/verify, /settle, /usage, POST /discovery/resources)
 *     never default open: origins must be explicitly allowlisted in CORS_ALLOWED_ORIGINS.
 */

export const EXPOSED_HEADERS = [
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
  'EXTENSION-RESPONSES',
].join(', ');

function compileOriginPatterns(entries) {
  return entries.map(entry => {
    try {
      return new RegExp(`^(?:${entry})$`);
    } catch (err) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS entry "${entry}" is not a valid regular expression: ${err.message}`,
      );
    }
  });
}

function originMatches(patterns, origin) {
  if (!origin) return false;
  if (patterns.some(pattern => pattern.test(origin))) return true;

  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }

  const labels = hostname.split('.');
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (patterns.some(pattern => pattern.test(suffix))) return true;
  }
  return false;
}

export function createCorsHook(corsConfig = {}) {
  const allowedOrigins = corsConfig.allowedOrigins ?? [];
  const patterns = compileOriginPatterns(allowedOrigins);

  return function cors(policy) {
    return async (req, reply) => {
      reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);

      const origin = req.headers.origin;
      const allowlisted = originMatches(patterns, origin);
      let granted;
      if (policy === 'public') {
        granted = allowlisted ? origin : allowedOrigins.length === 0 ? '*' : false;
      } else {
        granted = allowlisted ? origin : false;
      }

      const existingVary = reply.getHeader ? reply.getHeader('Vary') : undefined;
      const varyTokens = [];
      const seen = new Set();

      const addTokens = values => {
        const entries = Array.isArray(values) ? values : [values];
        for (const entry of entries) {
          for (const token of String(entry).split(',')) {
            const normalized = token.trim();
            if (!normalized) continue;
            const key = normalized.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              varyTokens.push(normalized);
            }
          }
        }
      };

      if (existingVary) addTokens(existingVary);
      addTokens('Origin');
      if (req.headers['accept-encoding']) {
        addTokens('Accept-Encoding');
      }
      reply.header('Vary', varyTokens.join(', '));

      if (granted) {
        reply.header('Access-Control-Allow-Origin', granted);
        if (granted !== '*') {
          reply.header('Access-Control-Allow-Credentials', 'true');
        }
      }
    };
  };
}

const ALLOWED_REQUEST_HEADERS = 'Authorization, Content-Type, X-402-Payment';

const DEFAULT_PREFLIGHT_MAX_AGE = {
  authenticated: 60,
  public: 600,
};

export function resolvePreflightMaxAge(corsConfig = {}, policy) {
  const overrides = corsConfig.preflightMaxAgeSeconds;
  if (overrides && typeof overrides === 'object') {
    const policySpecific = overrides[policy];
    if (
      typeof policySpecific === 'number' &&
      Number.isFinite(policySpecific) &&
      policySpecific > 0
    ) {
      return policySpecific;
    }
  }
  return DEFAULT_PREFLIGHT_MAX_AGE[policy] ?? DEFAULT_PREFLIGHT_MAX_AGE.public;
}

export function createPreflightHandler(corsConfig = {}) {
  const cors = createCorsHook(corsConfig);
  return function preflight(policy, methods) {
    const allowMethods = methods ?? (policy === 'public' ? 'GET, OPTIONS' : 'POST, OPTIONS');
    const maxAge = resolvePreflightMaxAge(corsConfig, policy);
    return async (req, reply) => {
      await cors(policy)(req, reply);
      reply.header('Access-Control-Allow-Methods', allowMethods);
      reply.header('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
      reply.header('Access-Control-Max-Age', String(maxAge));
      return reply.code(204).send();
    };
  };
}
