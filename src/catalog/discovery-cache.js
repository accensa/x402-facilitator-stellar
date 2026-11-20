/**
 * Discovery HTTP caching and weak ETag generator (#200).
 *
 * Emits Cache-Control, weak ETag (keyed on catalog version and sorted query params),
 * and Last-Modified headers, and applies RFC 9110 conditional requests
 * (If-None-Match with weak comparison and `*`, else If-Modified-Since).
 */
import crypto from 'node:crypto';

/**
 * Nesting cap for {@link stableParamValue}. Query-string parsers that build
 * nested params (`extensions[asset]=USDC`) cap depth well below this, so the
 * limit only exists to guarantee termination on pathological input.
 */
export const MAX_DISCOVERY_PARAM_DEPTH = 32;

/** Placeholder for a value nested past the cap or reached through a cycle. */
const UNSERIALISABLE = '[unserialisable]';

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical, JSON-ready form of a nested param value (#683): plain objects get
 * their keys sorted (undefined members dropped, as `JSON.stringify` would),
 * arrays are sorted by each element's serialised form, and scalars pass
 * through. Two values that differ only in key order or array order canonicalise
 * to the same structure; any other difference survives into the output.
 *
 * @param {unknown} v
 * @param {number} depth
 * @param {WeakSet<object>} seen - ancestors on the current path (cycle guard)
 * @returns {unknown}
 */
function stableParamValue(v, depth, seen) {
  const nested = Array.isArray(v) || isPlainObject(v);
  if (!nested) return v;
  if (depth >= MAX_DISCOVERY_PARAM_DEPTH || seen.has(v)) return UNSERIALISABLE;

  seen.add(v);
  let out;
  if (Array.isArray(v)) {
    out = v
      .map(item => stableParamValue(item, depth + 1, seen))
      .map(item => ({ item, key: JSON.stringify(item) ?? 'undefined' }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ item }) => item);
  } else {
    out = {};
    for (const key of Object.keys(v).sort()) {
      if (v[key] === undefined) continue;
      out[key] = stableParamValue(v[key], depth + 1, seen);
    }
  }
  seen.delete(v);
  return out;
}

function isScalar(v) {
  return v === null || (typeof v !== 'object' && typeof v !== 'function');
}

/**
 * Stable, dependency-free serialization of the params that shape a discovery
 * response, so the ETag is stable across request encodings of the same filter.
 * Keys are sorted, arrays are sorted, and undefined/null are dropped.
 *
 * Scalars and arrays of scalars serialise exactly as they always have, so
 * existing validators do not change. A plain-object value (a nested filter
 * such as `extensions[asset]=USDC`) is serialised as sorted-key JSON instead
 * of collapsing to `[object Object]`, and an array holding objects or arrays
 * is sorted by each element's serialised form (#683).
 *
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function canonicalizeDiscoveryParams(params) {
  const out = {};
  for (const key of Object.keys(params || {}).sort()) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      out[key] = v.every(isScalar)
        ? v.slice().sort()
        : stableParamValue(v, 0, new WeakSet()).map(item => JSON.stringify(item) ?? 'undefined');
    } else if (isPlainObject(v)) {
      out[key] = JSON.stringify(stableParamValue(v, 0, new WeakSet()));
    } else {
      out[key] = String(v);
    }
  }
  return JSON.stringify(out);
}

/**
 * Weak ETag for a discovery response (#200). Keyed on BOTH the monotonic
 * catalog version (any write changes it, so it invalidates every cached
 * variant at once) AND the full parameter set (different filters are different
 * representations and must never share a validator).
 *
 * @param {number|string} catalogVersion
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function discoveryETag(catalogVersion, params) {
  const hash = crypto
    .createHash('sha1')
    .update(canonicalizeDiscoveryParams(params))
    .digest('base64url')
    .replace(/=+$/, '');
  return `W/"${catalogVersion}-${hash}"`;
}

/**
 * Strips a leading `W/` from an entity-tag, leaving its opaque tag (#687).
 *
 * RFC 9110 §8.8.3.2: weak comparison uses the opaque tag only and ignores the
 * weakness indicator, so a client echoing the strong form of the same tag still
 * matches the weak validator we publish. The opaque tag itself is compared
 * case-sensitively, and trimming is safe because entries are comma-separated
 * lists with optional whitespace.
 *
 * @param {string} value
 * @returns {string}
 */
function opaqueTag(value) {
  const tag = String(value).trim();
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * If-None-Match evaluation per RFC 9110 §13.1.2: `*` matches any existing
 * representation, and every entry is compared with the weak comparison
 * function. Empty entries from a trailing or doubled comma are skipped.
 *
 * @param {string|string[]|undefined} header
 * @param {string} etag - our weak validator
 * @returns {boolean}
 */
function matchesIfNoneMatch(header, etag) {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string') return false;

  const candidates = raw
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (candidates.length === 0) return false;

  if (candidates.includes('*')) return true;

  const ours = opaqueTag(etag);
  return candidates.some(candidate => opaqueTag(candidate) === ours);
}

/**
 * If-Modified-Since evaluation per RFC 9110 §13.1.3: honoured only when the
 * resource has a last-modified validator, and ignored entirely when the date
 * cannot be parsed (a malformed precondition is not a match). Both sides are
 * compared at the header's one-second granularity so our sub-second clock never
 * makes an equal date look newer.
 *
 * @param {string|string[]|undefined} header
 * @param {number|null} lastModifiedMs
 * @returns {boolean}
 */
function matchesIfModifiedSince(header, lastModifiedMs) {
  if (lastModifiedMs === null) return false;
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || !raw.trim()) return false;

  const since = Date.parse(raw.trim());
  if (!Number.isFinite(since)) return false;

  return Math.floor(lastModifiedMs / 1000) * 1000 <= Math.floor(since / 1000) * 1000;
}

/**
 * Applies discovery caching headers (Cache-Control, ETag, Last-Modified)
 * and determines whether the request's preconditions are satisfied, following
 * the RFC 9110 §13.2.2 precedence rules (#687):
 *
 *   - If-None-Match is evaluated first and, when present, If-Modified-Since is
 *     ignored entirely — even if the tag does not match;
 *   - If-None-Match: * matches any existing discovery representation;
 *   - entity-tags use the weak comparison function, so the strong form of the
 *     same tag and the weak form both match;
 *   - If-Modified-Since is honoured only on its own, and a malformed date is
 *     ignored (a normal 200, not a 304);
 *   - only GET and HEAD are conditional; other methods always get a 200.
 *
 * The 304 is still an empty body built by the caller, and every validator and
 * the cache policy stay on the response.
 *
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @param {object} catalog
 * @param {object} [discoveryCacheConfig]
 * @param {Record<string, unknown>} params
 * @returns {{ etag: string, notModified: boolean }}
 */
export function applyDiscoveryCache(req, reply, catalog, discoveryCacheConfig, params) {
  const policy = discoveryCacheConfig ?? { maxAgeSeconds: 60, staleWhileRevalidateSeconds: 300 };
  const cc = `public, max-age=${policy.maxAgeSeconds}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`;
  reply.header('cache-control', cc);

  const version = typeof catalog.getVersion === 'function' ? catalog.getVersion() : 0;
  const etag = discoveryETag(version, params);
  reply.header('etag', etag);

  let lastModifiedMs = null;
  if (typeof catalog.getLastModified === 'function') {
    const lm = catalog.getLastModified();
    if (lm) {
      lastModifiedMs = new Date(lm).getTime();
      if (!Number.isFinite(lastModifiedMs)) lastModifiedMs = null;
      else reply.header('last-modified', new Date(lastModifiedMs).toUTCString());
    }
  }

  const headers = req.headers || {};
  const method = String(req.method || 'GET').toUpperCase();
  const conditional = method === 'GET' || method === 'HEAD';

  let notModified = false;
  if (conditional) {
    const inm = headers['if-none-match'];
    if (inm !== undefined) {
      // Present means authoritative: If-Modified-Since is ignored even here.
      notModified = matchesIfNoneMatch(inm, etag);
    } else {
      notModified = matchesIfModifiedSince(headers['if-modified-since'], lastModifiedMs);
    }
  }

  return { etag, notModified };
}
