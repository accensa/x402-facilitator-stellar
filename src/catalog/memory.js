/**
 * In-memory catalog store.
 *
 * This implementation uses a Map for storage and an EmbeddingClient for
 * semantic search. Pagination parameters (limit, offset) are assumed to be
 * validated and clamped by the API boundary layer (src/app.js) before being
 * passed to these methods. The catalog interface guarantees that limit and
 * offset are safe integers within acceptable bounds.
 */
import { scoreResource, toEpochMillis } from './search.js';
import { EmbeddingClient } from './embeddings.js';
import { CatalogStore } from './interface.js';

/** Stable reason code for the catalog-flooding guard (#186). */
export const MAX_RESOURCES_PER_PAYTO_CODE = 'maximum_resources_per_payto_exceeded';

/** Stable reason code for the overall catalog size limit (#224). */
export const MAX_CATALOG_SIZE_CODE = 'maximum_catalog_size_exceeded';

/** Typed catalog error with a stable code, surfaced identically on every path. */
export class CatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class MemoryCatalogStore extends CatalogStore {
  constructor(config = {}) {
    super();
    this.resources = new Map();
    // Per-payTo count kept in lockstep with `resources` so the cap check is
    // O(1) instead of a full catalog scan on every insert (#186).
    this.payToCounts = new Map();
    this.maxResourcesPerPayTo =
      config.maxResourcesPerPayTo ?? config.catalogMaxResourcesPerPayTo ?? 50;
    // Overall catalog size limit (#224) to prevent unbounded growth.
    this.maxCatalogSize = config.maxCatalogSize ?? config.catalogMaxSize ?? 10000;
    this.verifyTtlMs = config.catalogVerifyTtlMs ?? 24 * 60 * 60 * 1000;
    this.embeddingClient = new EmbeddingClient(config.embeddingsUrl, {
      timeoutMs: config.embeddingsTimeoutMs,
      rerankUrl: config.rerankUrl,
    });
    // Reranking needs a real endpoint (#170): the flag on its own used to fall
    // back to a guessed `${EMBEDDINGS_URL}/rerank` path that no provider serves,
    // so "reranking enabled" and "reranking happening" were different things.
    // resolveConfig refuses that combination in a real deployment; a store built
    // directly (tests, the eval harness) degrades loudly instead of silently.
    this.enableReranking = Boolean(config.enableReranking && config.rerankUrl);
    if (config.enableReranking && !config.rerankUrl) {
      console.warn(
        '[Catalog] ENABLE_RERANKING is on but no RERANK_URL is configured — reranking stays off and results are served in fused order',
      );
    }
    // Track in-flight background embedding promises so callers can await
    // all of them via flush() instead of relying on a hardcoded sleep.
    this._pendingEmbeddings = new Set();
    // Monotonic catalog version, bumped on every write (#200). It backs the
    // weak ETag discovery responses emit, so a write invalidates every cached
    // listing/search in one move. Starts at 0 (an untouched catalog).
    this._version = 0;
    this._lastModified = new Date(0);
  }

  /** Monotonic write counter — see #200. */
  getVersion() {
    return this._version;
  }

  /** Timestamp of the most recent write, for Last-Modified (#200). */
  getLastModified() {
    return this._lastModified;
  }

  _key(resource) {
    return resource.type === 'mcp' ? `${resource.url}::${resource.toolName}` : `${resource.url}::`;
  }

  /**
   * A verify-only listing (`source: 'verify'`) is provisional: it is visible for
   * discoverability but lacks the proof of a real payment, so once its window
   * elapses it must stop being public. Settled and manual listings are never
   * provisional (#140).
   */
  _isExpired(entry) {
    if (!entry?.provisional) return false;
    if (entry.expires_at == null) return true;
    return Date.now() >= new Date(entry.expires_at).getTime();
  }

  _isPublic(entry) {
    return !this._isExpired(entry);
  }

  _incrementPayToCount(payTo) {
    this.payToCounts.set(payTo, (this.payToCounts.get(payTo) ?? 0) + 1);
  }

  _decrementPayToCount(payTo) {
    const next = (this.payToCounts.get(payTo) ?? 1) - 1;
    if (next <= 0) this.payToCounts.delete(payTo);
    else this.payToCounts.set(payTo, next);
  }

  async upsertResource(resource, source = 'manual') {
    const key = this._key(resource);
    const existing = this.resources.get(key);

    // Limit resources per payTo to prevent catalog flooding (#186).
    // O(1) via the maintained per-payTo counter; the cap is configurable via
    // CATALOG_MAX_RESOURCES_PER_PAYTO.
    if (!existing) {
      const payToCount = this.payToCounts.get(resource.payTo) ?? 0;
      if (payToCount >= this.maxResourcesPerPayTo) {
        throw new CatalogError(
          MAX_RESOURCES_PER_PAYTO_CODE,
          `maximum resources per payTo (${this.maxResourcesPerPayTo}) exceeded`,
        );
      }
      // Overall catalog size limit (#224) to prevent unbounded growth.
      if (this.resources.size >= this.maxCatalogSize) {
        throw new CatalogError(
          MAX_CATALOG_SIZE_CODE,
          `maximum catalog size (${this.maxCatalogSize}) exceeded`,
        );
      }
    }

    const now = new Date();
    // A changed payTo on an existing listing is flagged per policy.
    // For now, we will log a warning.
    if (existing && existing.payTo !== resource.payTo) {
      console.warn(
        `[Catalog] Resource ${key} changed payTo from ${existing.payTo} to ${resource.payTo}`,
      );
    }

    // Provenance and lifetime (#140). A verify proves nothing was paid, so a
    // listing it creates is provisional and expires unless a settlement
    // promotes it. A listing created by a settle (or by hand) is permanent
    // public state. A settle/manual write always promotes — even one landing
    // on an old provisional entry — and never demotes an already-settled one.
    const existingSettled = existing != null && existing.source !== 'verify';
    const provisional = source === 'verify' && !existingSettled;
    const expiresAt = provisional ? now.getTime() + this.verifyTtlMs : null;
    // Provenance records how a listing entered the catalog: a verify touching
    // an already-settled listing must not mask its permanent origin.
    const recordedSource = existingSettled ? existing.source : source;

    const entry = {
      ...existing,
      ...resource,
      source: recordedSource,
      provisional,
      expires_at: expiresAt,
      last_seen_at: now,
      first_seen_at: existing ? existing.first_seen_at : now,
    };

    this.resources.set(key, entry);
    if (!existing) {
      this._incrementPayToCount(resource.payTo);
    }

    // A write is a write, overwrite or not: bump the monotonic version so every
    // cached discovery response is invalidated (its weak ETag changes) in one
    // move rather than being served stale until a TTL expires.
    this._version += 1;
    this._lastModified = now;

    // Re-embed asynchronously without blocking the upsert (or the payment path)
    this._scheduleEmbed(entry);

    return entry;
  }

  /**
   * Re-embeds a resource in the background when an embedding provider is wired
   * up, never blocking the upsert or the payment path. `_afterEmbedding` is a
   * hook that durable stores override to persist the freshly-computed vector
   * (#139) — the base implementation stores nothing.
   *
   * A vector describes the text it was computed from, and nothing else (#220).
   * `entry` is built as `{...existing, ...resource}`, so it inherits the
   * *previous* vector; when the new content composes to different text that
   * vector is no longer a description of this resource, and the dense search
   * leg would go on ranking it by content that no longer exists — silently,
   * because a failed re-embed only logs a warning. So the stale vector is
   * dropped **now**, synchronously, before the embed is attempted: while the
   * new vector is being computed the resource ranks lexically (honest), rather
   * than densely against the wrong document (confident and wrong). If the
   * re-embed then fails, the drop has already happened and stays.
   *
   * When the text is *unchanged* the inherited vector is still correct, and a
   * failed re-embed is then only a wasted call — it keeps the vector it has.
   */
  _scheduleEmbed(entry) {
    if (!this.embeddingClient.url) return;

    const fingerprint = this._documentFingerprint(entry);
    // The vector matches the content: nothing to recompute, and nothing to
    // invalidate. Skipping here also keeps a verify that re-touches an
    // unchanged listing from re-embedding it on every payment.
    if (entry.embedding && entry.embedding_source === fingerprint) return;

    // Synchronous, so the entry a durable store persists on this upsert is
    // already the invalidated one — the removal cannot lose a race with the
    // background write.
    delete entry.embedding;
    delete entry.embedding_source;

    const p = Promise.resolve().then(async () => {
      try {
        const text = this.embeddingClient.composeDocument(entry);
        const vector = await this.embeddingClient.embed(text);
        if (vector) {
          entry.embedding = vector;
          entry.embedding_source = fingerprint;
          await this._afterEmbedding(entry);
        }
      } catch (err) {
        // The vector is already gone and already persisted as gone; the
        // resource falls back to lexical ranking until a later upsert
        // recomputes it.
        console.warn(`[Catalog] Failed to re-embed ${this._key(entry)}: ${err.message}`);
      } finally {
        this._pendingEmbeddings.delete(p);
      }
    });
    this._pendingEmbeddings.add(p);
  }

  /**
   * A stable fingerprint of the text a vector would be computed from.
   *
   * This is a change *detector*, not a security measure: it decides whether
   * the vector already attached to an entry still describes that entry. A
   * cheap non-cryptographic hash is sufficient and keeps the payment path
   * free of a hash of the full document on every upsert — but it must be
   * collision-resistant enough that two genuinely different listings do not
   * share one, so it is a real 64-bit hash rather than a length or a prefix.
   */
  _documentFingerprint(entry) {
    const text = this.embeddingClient.composeDocument(entry);
    // FNV-1a, 64-bit via two 32-bit lanes. Not cryptographic; see above.
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + c) >>> 0;
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return `${text.length}:${h1.toString(16)}:${h2.toString(16)}`;
  }

  /** Hook for durable stores to persist a freshly-computed embedding vector. */
  async _afterEmbedding() {}

  /**
   * Await all in-flight background embedding requests.
   * Use this in tests and eval harnesses instead of a fixed sleep:
   *
   *   await store.flush(); // deterministic — no setTimeout needed
   */
  async flush() {
    await Promise.allSettled([...this._pendingEmbeddings]);
  }

  async getResource(url, toolName = null) {
    const key = toolName ? `${url}::${toolName}` : `${url}::`;
    const entry = this.resources.get(key) || null;
    return entry && this._isPublic(entry) ? entry : null;
  }

  /**
   * Removes a listing outright (#221). Unlike an expiry this is not a hide: the
   * entry, its payTo accounting and its vector all go, so a later verify
   * re-creates it as a fresh provisional listing rather than resurrecting the
   * old one.
   *
   * Deletion is by exact key, so it deliberately does *not* consult `_isPublic`:
   * an expired-but-not-yet-pruned entry is still occupying its key, and refusing
   * to remove it would make a listing that is invisible to every read
   * impossible to delete by the only route that can name it.
   */
  async deleteResource(url, toolName = null) {
    const key = toolName ? `${url}::${toolName}` : `${url}::`;
    const entry = this.resources.get(key);
    if (!entry) return { removed: false, resource: null };

    this.resources.delete(key);
    this._decrementPayToCount(entry.payTo);
    // A removal is a catalog write: bump the version so cached discovery
    // responses are invalidated rather than serving the deleted listing until
    // their TTL expires (#200).
    this._version += 1;
    this._lastModified = new Date();

    return { removed: true, resource: entry };
  }

  /**
   * Applies the common filter set used by both listResources and search (#227).
   * Extracted to eliminate duplication and ensure consistent filtering behavior.
   */
  _applyCommonFilters(items, params) {
    if (params.type) items = items.filter(r => r.type === params.type);
    if (params.payTo) items = items.filter(r => r.payTo === params.payTo);
    if (params.scheme) items = items.filter(r => r.scheme === params.scheme);
    if (params.network) items = items.filter(r => r.network === params.network);
    if (params.extensions && Array.isArray(params.extensions)) {
      items = items.filter(r => {
        const resourceExts = Object.keys(r.extensions || {});
        return params.extensions.every(ext => resourceExts.includes(ext));
      });
    }
    return items;
  }

  async listResources(params = {}) {
    let items = Array.from(this.resources.values()).filter(item => this._isPublic(item));
    items = this._applyCommonFilters(items, params);

    // Sort by first_seen_at desc, then key asc to ensure deterministic order
    // Use toEpochMillis for safe conversion (#223) instead of assuming Date
    items.sort((a, b) => {
      const timeA = toEpochMillis(a.first_seen_at);
      const timeB = toEpochMillis(b.first_seen_at);
      const timeDiff = (timeB ?? 0) - (timeA ?? 0);
      if (timeDiff !== 0) return timeDiff;
      const keyA = this._key(a);
      const keyB = this._key(b);
      return keyA.localeCompare(keyB);
    });

    const total = items.length;

    // Assume limit and offset are validated and clamped by API boundary
    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;

    return {
      items: items.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Physically removes expired provisional (verify-only) listings so they do
   * not accumulate forever (#140). Called lazily by a background sweep rather
   * than on the payment hot path. Returns the number of entries pruned.
   */
  async pruneExpired() {
    let pruned = 0;
    for (const [key, entry] of this.resources) {
      if (this._isExpired(entry)) {
        this.resources.delete(key);
        this._decrementPayToCount(entry.payTo);
        pruned += 1;
      }
    }
    return pruned;
  }

  async search(params) {
    let items = Array.from(this.resources.values()).filter(item => this._isPublic(item));
    items = this._applyCommonFilters(items, params);

    let partialResults = false;
    let queryVector = null;

    if (this.embeddingClient.url) {
      queryVector = await this.embeddingClient.embed(params.query);
      if (!queryVector) {
        partialResults = true;
      }
    } else {
      partialResults = true; // No provider available
    }

    const lexicalScores = [];
    const denseScores = [];

    for (const item of items) {
      const lexScore = scoreResource(item, params.query);
      if (lexScore > 0) {
        lexicalScores.push({ item, score: lexScore });
      }

      if (queryVector) {
        if (item.embedding) {
          const denseScore = cosineSimilarity(queryVector, item.embedding);
          if (denseScore > 0.1) {
            // Threshold for relevance
            denseScores.push({ item, score: denseScore });
          }
        } else {
          // Resource hasn't been embedded yet or embedding failed
          partialResults = true;
        }
      }
    }

    // Rank and assign RRF (Reciprocal Rank Fusion)
    const k = 60;
    const rrfScores = new Map(); // item key -> rrf score

    lexicalScores.sort((a, b) => b.score - a.score);
    lexicalScores.forEach((s, rank) => {
      const key = this._key(s.item);
      rrfScores.set(key, 1 / (k + rank + 1));
    });

    denseScores.sort((a, b) => b.score - a.score);
    denseScores.forEach((s, rank) => {
      const key = this._key(s.item);
      const current = rrfScores.get(key) || 0;
      rrfScores.set(key, current + 1 / (k + rank + 1));
    });

    const combinedItems = [];
    for (const item of items) {
      const key = this._key(item);
      if (rrfScores.has(key)) {
        combinedItems.push({ item, score: rrfScores.get(key) });
      }
    }

    combinedItems.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return this._key(a.item).localeCompare(this._key(b.item));
    });

    // Assume limit is validated and clamped by API boundary
    const limit = params.limit ?? 20;

    let startIndex = 0;
    if (params.cursor) {
      try {
        const cursorStr = Buffer.from(params.cursor, 'base64').toString('utf8');
        if (cursorStr.startsWith('offset:')) {
          startIndex = parseInt(cursorStr.substring(7), 10);
        }
      } catch {
        // invalid cursor, ignore
      }
    }

    // Ensure startIndex is within bounds
    startIndex = Math.max(0, Math.min(startIndex, combinedItems.length));

    let paginatedItems = combinedItems.slice(startIndex, startIndex + limit).map(s => s.item);

    // Second pass over the page only — reranking reorders the fused page, it
    // never adds candidates (#170). The client returns the page unchanged when
    // the provider is unconfigured, down, or answers with something other than
    // the documented contract, and logs why in each of those cases.
    if (this.enableReranking && paginatedItems.length > 0) {
      paginatedItems = await this.embeddingClient.rerank(params.query, paginatedItems);
    }

    let nextCursor = null;
    if (startIndex + limit < combinedItems.length) {
      nextCursor = Buffer.from(`offset:${startIndex + limit}`).toString('base64');
    }

    return {
      resources: paginatedItems,
      partialResults,
      pagination: {
        limit,
        cursor: nextCursor,
      },
    };
  }
}
