/**
 * Client-IP pseudonymisation (#204).
 *
 * docs/PRIVACY.md commits to not retaining IP addresses, but several paths did
 * exactly that: the rate-limit bucket id embedded the raw `req.ip`, so a shared
 * store (Redis, `RATE_LIMIT_STORE=postgres`, CRDT) persisted plaintext
 * addresses beyond the transient memory window; audit records used
 * `ip:<addr>`; and the catalog rate-limit warning printed the address to
 * stdout.
 *
 * The fix is a single choke point: resolve `req.ip` to a stable pseudonym
 * before anything downstream reads it (see app.js). A pseudonym has to satisfy
 * two constraints at once —
 *
 *   1. Stable for the same address, so the limiter still buckets one caller
 *      together (a per-request random value would disable rate limiting).
 *   2. Not reversible back to the address, so the persisted bucket has no
 *      personal data in it.
 *
 * A plain digest of an IPv4 address is brute-forceable (the space is 2^32), so
 * a keyed hash is used when a secret is available. `IP_HASH_SECRET` supplies
 * one explicitly; when it is unset the server derives a key from the
 * facilitator signer secret, which is already required to be secret. With no
 * key at all (unit tests, a bare config) it falls back to a plain digest —
 * still no plaintext on disk, just weaker against an offline attacker.
 *
 * Rotating the key re-keys every bucket, which resets in-flight windows. That
 * is the documented trade-off; see docs/PRIVACY.md.
 */
import crypto from 'node:crypto';

/** 12 bytes → 24 hex chars: collision-safe for a rate-limit bucket space, short in a log line. */
const DIGEST_BYTES = 12;

/**
 * Returns a stable, non-reversible digest of an IP address.
 *
 * @param {string} ip - the resolved client address (`req.ip`)
 * @param {{secret?: string|Buffer}} [options] - HMAC key; absent means a plain
 *   SHA-256 digest
 * @returns {string|undefined|null} 24 hex characters, or undefined/null for an absent address.
 */
export function pseudonymizeIp(ip, { secret } = {}) {
  if (ip === undefined || ip === '') return undefined;
  if (ip === null) return null;
  const value = String(ip);
  const digest = secret
    ? crypto.createHmac('sha256', String(secret)).update(value).digest()
    : crypto.createHash('sha256').update(value).digest();
  return digest.toString('hex').slice(0, DIGEST_BYTES * 2);
}

/**
 * Builds the function the transport calls once per request.
 *
 * @param {{secret?: string|Buffer}} [options]
 * @returns {(ip: string) => string|undefined}
 */
export function createIpPseudonymizer({ secret } = {}) {
  return ip => pseudonymizeIp(ip, { secret });
}

/**
 * Builds the onRequest hook that resolves and pseudonymises the caller address.
 *
 * @param {(ip: string|undefined|null) => string|undefined|null} ipPseudonymizer
 * @param {(event: string, fields: object) => void} audit
 * @returns {(req: object, reply: object) => Promise<object|void>}
 */
export function createIpPseudonymizationHook(ipPseudonymizer, audit) {
  return async (req, reply) => {
    const resolved = ipPseudonymizer(req.ip);
    const peer = req.socket?.remoteAddress ?? req.connection?.remoteAddress;
    const pseudonym = resolved || ipPseudonymizer(peer);

    if (pseudonym) {
      if (pseudonym !== req.ip) {
        Object.defineProperty(req, 'ip', { value: pseudonym, configurable: true });
      }
      return;
    }

    Object.defineProperty(req, 'ip', { value: undefined, configurable: true });
    if (req.span) {
      req.span.outcome = 'rejected';
      req.span.reason = 'client_address_unresolved';
    }
    audit('auth_failure', {
      actor: req.keyId ?? 'unknown',
      route: req.span?.route ?? req.url?.split('?')[0] ?? 'unknown',
      reason: 'client_address_unresolved',
      outcome: 'rejected',
    });
    return reply.code(400).send({
      error: 'invalid_request',
      reason: 'client_address_unresolved',
    });
  };
}

/**
 * Derives an HMAC key from the facilitator signer secret, so pseudonymisation
 * is keyed by default with no new required configuration. Domain-separated
 * from the signing use of the same secret: it can never be confused with a
 * signing operation, and it is stable for the lifetime of the deployment.
 *
 * @param {string} signerSecret - a Stellar `S...` secret
 * @returns {Buffer|null}
 */
export function deriveIpHashSecret(signerSecret) {
  if (!signerSecret || typeof signerSecret !== 'string') return null;
  return crypto.createHash('sha256').update(`x402:ip-pseudonym:v1:${signerSecret}`).digest();
}
