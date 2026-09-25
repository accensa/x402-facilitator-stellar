import { fetch } from 'undici';

/** Default outbound timeout for embedding/rerank calls (ms). */
const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 3000;

/** Small state for timeout/failure accounting per provider. */
class ProviderHealth {
  constructor() {
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.timeouts = 0;
    this.failures = 0;
    this.successes = 0;
  }
}

export class EmbeddingClient {
  constructor(url, config = {}) {
    this.url = url;
    // #170: the rerank endpoint is configured as a full URL. It is NOT derived
    // from `url` — posting to `${EMBEDDINGS_URL}/rerank` invents a path no real
    // provider serves, which is how a deployment could believe it was reranking
    // while every query was silently served in fused order.
    this.rerankUrl = config.rerankUrl ?? null;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_EMBEDDINGS_TIMEOUT_MS;
    // After this many consecutive failures, stop calling the provider for a
    // cooldown window (a down provider should cost one timeout, not one per
    // request).
    this.circuitBreakerThreshold = config.circuitBreakerThreshold ?? 3;
    this.circuitBreakerCooldownMs = config.circuitBreakerCooldownMs ?? 30_000;
    this.health = new ProviderHealth();
    // Embeddings and reranking are separate services with separate failure
    // modes, so they get separate breaker state (#170). Sharing one made a
    // flapping reranker suppress embedding calls, and vice versa.
    this.rerankHealth = new ProviderHealth();
    // Dimension of the first accepted vector; later vectors of a different
    // length are rejected with a loud, distinct log line.
    this.expectedDimension = null;
  }

  _inCooldown(health = this.health) {
    return Date.now() < health.cooldownUntil;
  }

  _recordFailure(
    timeout = false,
    { health = this.health, provider = 'Embedding provider', endpoint = this.url } = {},
  ) {
    health.consecutiveFailures += 1;
    if (timeout) health.timeouts += 1;
    else health.failures += 1;
    if (health.consecutiveFailures >= this.circuitBreakerThreshold) {
      health.cooldownUntil = Date.now() + this.circuitBreakerCooldownMs;
      console.warn(
        `[Catalog] ${provider} ${endpoint} failed ${health.consecutiveFailures} consecutive times; cooldown until ${new Date(health.cooldownUntil).toISOString()}`,
      );
    }
  }

  _recordSuccess(health = this.health) {
    health.consecutiveFailures = 0;
    health.successes += 1;
  }

  /**
   * Validates a provider embedding response.
   * Returns the vector when it is a non-empty array of finite numbers, else null.
   */
  _validateVector(embedding) {
    if (!Array.isArray(embedding) || embedding.length === 0) {
      console.warn(
        `[Catalog] Embedding provider ${this.url} returned a non-array or empty embedding`,
      );
      return null;
    }
    for (const value of embedding) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        console.warn(
          `[Catalog] Embedding provider ${this.url} returned a non-finite vector element`,
        );
        return null;
      }
    }
    return embedding;
  }

  /**
   * Composes a single text document from the resource for embedding.
   */
  composeDocument(resource) {
    const parts = [
      resource.serviceName || '',
      resource.description || '',
      (resource.tags || []).join(' '),
      resource.type || '',
    ];

    if (resource.extensions) {
      for (const [extName, extData] of Object.entries(resource.extensions)) {
        if (extData && extData.parameters) {
          parts.push(`Extension ${extName} parameters:`);
          for (const [paramName, paramDesc] of Object.entries(extData.parameters)) {
            parts.push(`${paramName}: ${paramDesc}`);
          }
        }
      }
    }

    return parts.filter(Boolean).join('. ');
  }

  /**
   * Fetches an embedding for the given text.
   * Returns an array of numbers (the vector), or null if the provider is
   * unavailable, timed out, or returned a malformed vector.
   */
  async embed(text) {
    if (!this.url) return null;

    // Circuit breaker: skip calls during a cooldown window.
    if (this._inCooldown()) {
      this.health.failures += 1;
      return null;
    }

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        this._recordFailure(false);
        return null;
      }

      const data = await response.json();
      const vector = this._validateVector(data.embedding);
      if (!vector) {
        this._recordFailure(false);
        return null;
      }

      // Dimension guard: a change means the index needs rebuilding — report it
      // loudly and reject rather than silently degrading search.
      if (this.expectedDimension === null) {
        this.expectedDimension = vector.length;
      } else if (vector.length !== this.expectedDimension) {
        console.error(
          `[Catalog] Embedding dimension changed: expected ${this.expectedDimension}, got ${vector.length} from ${this.url}. ` +
            'The index needs rebuilding; refusing the new vector.',
        );
        this._recordFailure(false);
        return null;
      }

      this._recordSuccess();
      return vector;
    } catch (err) {
      const timeout =
        err &&
        (err.name === 'TimeoutError' ||
          err.name === 'AbortError' ||
          err.message === 'The operation was aborted due to timeout');
      this._recordFailure(timeout);
      if (timeout) {
        console.warn(
          `[Catalog] Embedding provider ${this.url} timed out after ${this.timeoutMs}ms`,
        );
      }
      // Network failure, degrade gracefully
      return null;
    }
  }

  /**
   * Parses a rerank response into positional scores, or null when the payload
   * is not the documented contract. Returning null rather than an empty array
   * matters: a malformed payload is a provider failure to be logged and counted,
   * not a reranking that happened to preserve order.
   *
   * Accepted shapes (see docs/BAZAAR.md):
   *   { results: [ { index, relevance_score } ] }  — Cohere/Jina shape
   *   { scores: [number] }                          — positional shorthand
   */
  _parseRerankScores(data, count) {
    if (data && Array.isArray(data.results)) {
      const scores = new Array(count).fill(null);
      for (const result of data.results) {
        const index = result?.index;
        const score = result?.relevance_score ?? result?.score;
        if (!Number.isInteger(index) || index < 0 || index >= count) return null;
        if (typeof score !== 'number' || !Number.isFinite(score)) return null;
        if (scores[index] !== null) return null; // duplicate index: ambiguous order
        scores[index] = score;
      }
      // Every document must be scored. A partial list would silently rank the
      // unscored tail last, which reads as a ranking decision it never made.
      return scores.every(score => score !== null) ? scores : null;
    }

    if (
      data &&
      Array.isArray(data.scores) &&
      data.scores.length === count &&
      data.scores.every(score => typeof score === 'number' && Number.isFinite(score))
    ) {
      return data.scores;
    }

    return null;
  }

  /**
   * Optional second-pass cross-encoder reranking (#170).
   *
   * Contract, in one place (documented in docs/BAZAAR.md):
   *
   *   POST <RERANK_URL>   { query: string, documents: [string] }
   *   -> 200 { results: [ { index, relevance_score } ] }   (or { scores: [] })
   *
   * Returns `resources` reordered by relevance, or the input order when
   * reranking is not configured or has degraded. Every degradation is logged
   * with the endpoint and the reason — an unreranked page that reports nothing
   * is a search quality you cannot measure, and the previous implementation
   * swallowed every failure while POSTing to a path no provider serves.
   */
  async rerank(query, resources) {
    if (!this.rerankUrl || resources.length === 0) return resources;

    if (this._inCooldown(this.rerankHealth)) {
      this.rerankHealth.failures += 1;
      console.warn(
        `[Catalog] Rerank skipped: ${this.rerankUrl} is in cooldown until ${new Date(this.rerankHealth.cooldownUntil).toISOString()} — results are in fused order`,
      );
      return resources;
    }

    const documents = resources.map(r => this.composeDocument(r));

    let response;
    try {
      response = await fetch(this.rerankUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, documents }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timeout =
        err &&
        (err.name === 'TimeoutError' ||
          err.name === 'AbortError' ||
          err.message === 'The operation was aborted due to timeout');
      this._recordFailure(timeout, {
        health: this.rerankHealth,
        provider: 'Rerank provider',
        endpoint: this.rerankUrl,
      });
      console.warn(
        `[Catalog] Rerank failed: POST ${this.rerankUrl} ${
          timeout ? `timed out after ${this.timeoutMs}ms` : `errored (${err?.message ?? err})`
        } — results are in fused order, not reranked`,
      );
      return resources;
    }

    if (!response.ok) {
      this._recordFailure(false, {
        health: this.rerankHealth,
        provider: 'Rerank provider',
        endpoint: this.rerankUrl,
      });
      console.warn(
        `[Catalog] Rerank failed: POST ${this.rerankUrl} returned HTTP ${response.status} — results are in fused order, not reranked`,
      );
      return resources;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      this._recordFailure(false, {
        health: this.rerankHealth,
        provider: 'Rerank provider',
        endpoint: this.rerankUrl,
      });
      console.warn(
        `[Catalog] Rerank failed: POST ${this.rerankUrl} returned a body that is not JSON (${err?.message ?? err}) — results are in fused order, not reranked`,
      );
      return resources;
    }

    const scores = this._parseRerankScores(data, resources.length);
    if (!scores) {
      this._recordFailure(false, {
        health: this.rerankHealth,
        provider: 'Rerank provider',
        endpoint: this.rerankUrl,
      });
      console.warn(
        `[Catalog] Rerank failed: POST ${this.rerankUrl} returned an unrecognised payload (expected { results: [{ index, relevance_score }] } or { scores: [] } covering all ${resources.length} documents) — results are in fused order, not reranked`,
      );
      return resources;
    }

    this._recordSuccess(this.rerankHealth);
    return resources
      .map((resource, index) => ({ resource, score: scores[index] }))
      .sort((a, b) => b.score - a.score)
      .map(pair => pair.resource);
  }
}
