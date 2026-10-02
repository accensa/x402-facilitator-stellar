/**
 * Normalizes a `last_seen_at` value to epoch milliseconds, or null when the
 * value is not a Date, a number, or a parseable ISO string. Called at the
 * scorer boundary so a ranking helper can never throw on a stored value.
 */
export function toEpochMillis(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Search parameters, serialised into a stable cache key.
 *
 * The cache in `src/catalog/cache.js` is only worth anything if two callers
 * asking the same question land on the same key, so this canonicalises the
 * three ways the same request can be spelled:
 *
 *   - **key order** — `{query, limit}` and `{limit, query}` are one question,
 *     so object keys are emitted in sorted order;
 *   - **absent vs. default** — `search()` treats a missing `limit` as 20, so
 *     `?q=api` and `?q=api&limit=20` must not occupy two entries;
 *   - **whitespace** — the scorer already trims and lowercases the query, so a
 *     padded query is the same question.
 *
 * The cursor is part of the key, not normalised away: page 2 is a different
 * result set from page 1, and conflating them would hand out page 1 twice.
 *
 * **Every filter `CatalogStore.search()` supports belongs in this key.** A
 * filter left out is not a smaller cache, it is a wrong one: a caller asking for
 * `network=stellar:pubnet` would be served an entry cached for
 * `network=stellar:testnet`, and the result set is then a list of payees on the
 * wrong network. `_SCOPED_PARAMS` below is the list, and the test that guards it
 * derives its cases from the store's own filter list so a filter added there
 * without being added here fails the suite.
 *
 * @param {object} [params={}] - a `CatalogStore.search()` params object
 * @returns {string} a stable, collision-resistant key fragment
 */

/**
 * Params that narrow a search. Order is fixed so the key is deterministic; it
 * is not sorted at runtime because a fixed list is what makes the guard test
 * meaningful.
 */
const _SCOPED_PARAMS = ['type', 'payTo', 'scheme', 'network'];

/** Params whose absence means "no narrowing", and so normalise to ''. */
const _SCOPED_DEFAULTS = Object.freeze({ type: '', payTo: '', scheme: '', network: '' });

/** Pagination params that select a different slice, kept separate for clarity. */
const _PAGE_PARAMS = ['limit', 'offset', 'cursor'];

export function searchCacheKey(params = {}) {
  const query = typeof params.query === 'string' ? params.query.trim().toLowerCase() : '';
  const extensions = Array.isArray(params.extensions)
    ? [...params.extensions].map(String).sort()
    : [];

  // Sorted, explicit field list rather than JSON.stringify(params): an unknown
  // or newly added param must not silently split the cache into two namespaces
  // mid-deploy, so adding one here is a deliberate act.
  const scoped = _SCOPED_PARAMS.map(name => {
    const value = params[name];
    return typeof value === 'string' ? value.trim() : _SCOPED_DEFAULTS[name];
  });

  // `limit` mirrors search()'s own default; `offset` defaults to 0. A cursor
  // names a page, so it is compared as the exact opaque string it is.
  const limit = Number.isFinite(Number(params.limit)) ? Number(params.limit) : 20;
  const offset = Number.isFinite(Number(params.offset)) ? Number(params.offset) : 0;
  const cursor = typeof params.cursor === 'string' && params.cursor ? params.cursor : '';

  return JSON.stringify([query, limit, offset, cursor, extensions.join(','), ...scoped]);
}

/** @private Exported for the guard test; not part of the public surface. */
export function _scopedSearchParams() {
  return [..._SCOPED_PARAMS, ..._PAGE_PARAMS];
}

export function scoreResource(resource, query) {
  if (!query || !query.trim()) return 0;

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let score = 0;

  const serviceName = (resource.serviceName || '').toLowerCase();
  const description = (resource.description || '').toLowerCase();

  // Extract parameter descriptions from extensions
  const extDocs = [];
  if (resource.extensions && typeof resource.extensions === 'object') {
    // Deep search for "description" keys or just JSON stringify
    const extStr = JSON.stringify(resource.extensions).toLowerCase();
    extDocs.push(extStr);
  }

  for (const token of tokens) {
    if (serviceName.includes(token)) score += 10;

    if (resource.tags && Array.isArray(resource.tags)) {
      if (resource.tags.some(t => t.toLowerCase() === token)) {
        score += 8;
      } else if (resource.tags.some(t => t.toLowerCase().includes(token))) {
        score += 4;
      }
    }

    if (description.includes(token)) score += 3;

    for (const doc of extDocs) {
      if (doc.includes(token)) score += 1;
    }
  }

  if (score === 0) return 0;

  if (resource.source === 'payment') {
    score += 5; // Payment-verified boost
  }

  // Recency decay (half-life of ~30 days).
  // Accepts Date, number (epoch ms), or ISO string; skips decay on anything
  // else so a malformed stored value can never throw a 500.
  const lastSeenMs = toEpochMillis(resource.last_seen_at);
  if (lastSeenMs !== null) {
    const daysOld = (Date.now() - lastSeenMs) / (1000 * 60 * 60 * 24);
    if (daysOld > 0) {
      score = score * Math.exp(-daysOld / 43); // e^(-x/43) is approx 0.5 at x=30
    }
  }

  return score;
}
