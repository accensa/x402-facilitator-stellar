/**
 * In-memory catalog store.
 *
 * This implementation uses a Map for storage and an EmbeddingClient for
 * semantic search. Pagination parameters (limit, offset) are assumed to be
 * validated and clamped by the API boundary layer (src/app.js) before being
 * passed to these methods. The catalog interface guarantees that limit and
 * offset are safe integers within acceptable bounds.
 */
import { scoreResource } from './search.js';
import { EmbeddingClient } from './embeddings.js';

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

export class MemoryCatalogStore {
  constructor(config = {}) {
    this.resources = new Map();
    this.embeddingClient = new EmbeddingClient(config.embeddingsUrl);
    this.enableReranking = config.enableReranking;
    // Track in-flight background embedding promises so callers can await
    // all of them via flush() instead of relying on a hardcoded sleep.
    this._pendingEmbeddings = new Set();
  }

  _key(resource) {
    return resource.type === 'mcp' ? `${resource.url}::${resource.toolName}` : `${resource.url}::`;
  }

  async upsertResource(resource, source = 'manual') {
    const key = this._key(resource);
    const existing = this.resources.get(key);

    // Limit resources per payTo to prevent catalog flooding (max 50)
    if (!existing) {
      let payToCount = 0;
      for (const r of this.resources.values()) {
        if (r.payTo === resource.payTo) payToCount++;
      }
      if (payToCount >= 50) {
        throw new Error('maximum_resources_per_payto_exceeded');
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

    const entry = {
      ...existing,
      ...resource,
      source,
      last_seen_at: now,
      first_seen_at: existing ? existing.first_seen_at : now,
    };

    this.resources.set(key, entry);

    // Re-embed asynchronously without blocking the upsert (or the payment path)
    if (this.embeddingClient.url) {
      const p = Promise.resolve().then(async () => {
        try {
          const text = this.embeddingClient.composeDocument(entry);
          const vector = await this.embeddingClient.embed(text);
          if (vector) {
            entry.embedding = vector;
          }
        } catch (err) {
          console.warn(`[Catalog] Failed to re-embed ${key}: ${err.message}`);
        } finally {
          this._pendingEmbeddings.delete(p);
        }
      });
      this._pendingEmbeddings.add(p);
    }

    return entry;
  }

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
    return this.resources.get(key) || null;
  }

  async listResources(params = {}) {
    let items = Array.from(this.resources.values());

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

    // Sort by first_seen_at desc, then key asc to ensure deterministic order
    items.sort((a, b) => {
      const timeDiff = b.first_seen_at.getTime() - a.first_seen_at.getTime();
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

  async search(params) {
    let items = Array.from(this.resources.values());

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
