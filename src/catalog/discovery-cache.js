/**
 * Discovery HTTP caching and weak ETag generator (#200).
 *
 * Emits Cache-Control, weak ETag (keyed on catalog version and sorted query params),
 * and Last-Modified headers, with early 304 response on matching If-None-Match.
 */
import crypto from 'node:crypto';

/**
 * Stable, dependency-free serialization of the params that shape a discovery
 * response, so the ETag is stable across request encodings of the same filter.
 * Keys are sorted, arrays are sorted, and undefined/null are dropped.
 *
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function canonicalizeDiscoveryParams(params) {
  const out = {};
  for (const key of Object.keys(params || {}).sort()) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    out[key] = Array.isArray(v) ? v.slice().sort() : String(v);
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
 * Applies discovery caching headers (Cache-Control, ETag, Last-Modified)
 * and determines if an If-None-Match precondition was satisfied.
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

  if (typeof catalog.getLastModified === 'function') {
    const lm = catalog.getLastModified();
    if (lm) reply.header('last-modified', new Date(lm).toUTCString());
  }

  const inm = req.headers['if-none-match'];
  const notModified = inm
    ? inm
        .split(',')
        .map(s => s.trim())
        .includes(etag)
    : false;
  return { etag, notModified };
}
