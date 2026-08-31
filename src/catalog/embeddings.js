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
    this.timeoutMs = config.timeoutMs ?? DEFAULT_EMBEDDINGS_TIMEOUT_MS;
    // After this many consecutive failures, stop calling the provider for a
    // cooldown window (a down provider should cost one timeout, not one per
    // request).
    this.circuitBreakerThreshold = config.circuitBreakerThreshold ?? 3;
    this.circuitBreakerCooldownMs = config.circuitBreakerCooldownMs ?? 30_000;
    this.health = new ProviderHealth();
    // Dimension of the first accepted vector; later vectors of a different
    // length are rejected with a loud, distinct log line.
    this.expectedDimension = null;
  }

  _inCooldown() {
    return Date.now() < this.health.cooldownUntil;
  }

  _recordFailure(timeout = false) {
    this.health.consecutiveFailures += 1;
    if (timeout) this.health.timeouts += 1;
    else this.health.failures += 1;
    if (this.health.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.health.cooldownUntil = Date.now() + this.circuitBreakerCooldownMs;
      console.warn(
        `[Catalog] Embedding provider ${this.url} failed ${this.health.consecutiveFailures} consecutive times; cooldown until ${new Date(this.health.cooldownUntil).toISOString()}`,
      );
    }
  }

  _recordSuccess() {
    this.health.consecutiveFailures = 0;
    this.health.successes += 1;
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
   * Optional reranking pass using a cross-encoder model via an API.
   * Takes a query and a list of resources, returns the reranked list of resources.
   * If reranking is disabled or unavailable, returns the list unchanged.
   */
  async rerank(query, resources) {
    if (!this.url) return resources;

    if (this._inCooldown()) {
      this.health.failures += 1;
      return resources;
    }

    try {
      // Hypothetical cross-encoder API endpoint that expects query + pairs
      const response = await fetch(`${this.url}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          documents: resources.map(r => this.composeDocument(r)),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        this._recordFailure(false);
        return resources;
      }

      const data = await response.json();
      // Expecting { scores: [0.9, 0.1, 0.5] } matching the documents array
      if (data.scores && data.scores.length === resources.length) {
        const paired = resources.map((res, i) => ({ res, score: data.scores[i] }));
        paired.sort((a, b) => b.score - a.score);
        this._recordSuccess();
        return paired.map(p => p.res);
      }

      this._recordFailure(false);
      return resources;
    } catch (err) {
      const timeout =
        err &&
        (err.name === 'TimeoutError' ||
          err.name === 'AbortError' ||
          err.message === 'The operation was aborted due to timeout');
      this._recordFailure(timeout);
      return resources;
    }
  }
}
