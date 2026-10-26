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
 * Compiles the configured allowlist into anchored origin patterns (#414).
 *
 * A `CORS_ALLOWED_ORIGINS` entry is a merchant domain *pattern*, not a
 * literal: `https://.*\.merchant\.example` admits a merchant's whole
 * subdomain tree, while an exact origin such as `https://shop.example.com`
 * remains valid configuration — it is simply a pattern that matches only
 * itself. Entries are anchored to the whole string, so a pattern can never be
 * satisfied by an attacker hostname that merely *contains* the merchant's
 * (`seller.example.com` must not match `seller.example.com.evil.net`). An
 * entry's `.` is the regex wildcard it always was: write `seller\.example\.com`
 * when the host must match literally.
 *
 * Patterns are compiled once, here, at hook construction rather than on every
 * request. They come from operator configuration, never from a caller; an
 * entry that is not a valid regular expression throws now — at boot, naming
 * the entry — instead of misbehaving on the first cross-origin request.
 *
 * @param {string[]} entries - configured origins / merchant domain patterns
 * @returns {RegExp[]} the compiled patterns, each anchored at both ends
 * @throws {Error} when an entry is not a valid regular expression
 */
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

/**
 * Reports whether an `Origin` header value matches the compiled allowlist (#414).
 *
 * The full origin is tested first. Then each dot-aligned suffix of the
 * origin's hostname is tested, because a merchant normally configures a
 * domain (`shop.example.com`) without a scheme it never wrote. Splitting on
 * label boundaries is what makes `example.com` match `shop.example.com` while
 * still refusing `badexample.com`.
 *
 * @param {RegExp[]} patterns - compiled by compileOriginPatterns()
 * @param {string} [origin] - the request's Origin header, absent when nothing sent one
 * @returns {boolean}
 */
function originMatches(patterns, origin) {
  if (!origin) return false;
  if (patterns.some(pattern => pattern.test(origin))) return true;

  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // Not a URL an Origin header can legitimately hold ("null", a mangled
    // value): there is no hostname to match patterns against.
    return false;
  }

  const labels = hostname.split('.');
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (patterns.some(pattern => pattern.test(suffix))) return true;
  }
  return false;
}

/**
 * Creates a Fastify `onRequest` hook enforcing route-class CORS policies.
 *
 * @param {object} [corsConfig={}]
 * @param {string[]} [corsConfig.allowedOrigins=[]] - merchant domain patterns,
 *   compiled once by compileOriginPatterns() and matched against each
 *   request's Origin, which is then reflected verbatim when it matches (#414)
 * @returns {(policy: 'public' | 'authenticated') => (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>}
 */
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
        // Never default-open anything authenticated.
        granted = allowlisted ? origin : false;
      }

      reply.header('Vary', 'Origin');

      if (granted) {
        reply.header('Access-Control-Allow-Origin', granted);
        // A concrete reflection — never the wildcard — is the case where a
        // browser may attach credentials: `*` plus
        // Access-Control-Allow-Credentials is refused by the spec, so the
        // grant that admits a merchant's own origin is also the grant that
        // may carry its credentials (#414).
        if (granted !== '*') {
          reply.header('Access-Control-Allow-Credentials', 'true');
        }
      }
    };
  };
}

/**
 * Request headers a browser must be allowed to send on an x402 payment call
 * (#414). `Authorization` carries the caller's credential, `Content-Type` every
 * JSON POST, and `X-402-Payment` the payment header a client retries with —
 * nothing else is needed by an x402 caller, so a preflight advertises exactly
 * this list and no wider surface.
 */
const ALLOWED_REQUEST_HEADERS = 'Authorization, Content-Type, X-402-Payment';

/**
 * How long a browser may cache a preflight answer (#414): 24 hours, replacing
 * the 600s that made every payment route re-preflight itself ten times a day.
 */
const PREFLIGHT_MAX_AGE = '86400';

/**
 * Creates an OPTIONS preflight route handler for a given route class policy.
 *
 * @param {object} [corsConfig={}]
 * @param {string[]} [corsConfig.allowedOrigins=[]]
 * @returns {(policy: 'public' | 'authenticated', methods?: string) =>
 *   (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>}
 *   `methods` overrides the class default (`GET, OPTIONS` / `POST, OPTIONS`)
 *   for a route that serves a different verb set — `DELETE /discovery/resource`
 *   (#221), or the `GET /admin/dlq` routes, which had been advertising POST.
 */
export function createPreflightHandler(corsConfig = {}) {
  const cors = createCorsHook(corsConfig);
  return function preflight(policy, methods) {
    const allowMethods = methods ?? (policy === 'public' ? 'GET, OPTIONS' : 'POST, OPTIONS');
    return async (req, reply) => {
      await cors(policy)(req, reply);
      reply.header('Access-Control-Allow-Methods', allowMethods);
      reply.header('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
      reply.header('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
      return reply.code(204).send();
    };
  };
}
