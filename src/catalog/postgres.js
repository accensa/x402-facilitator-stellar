/**
 * Postgres-backed catalog store (#139).
 *
 * Postgres is chosen because it is already a hard dependency of the service
 * (DATABASE_URL) and already backs the settlement, idempotency and outbox
 * stores — adding a second datastore for the catalog would be a new
 * operational burden for no benefit.
 *
 * The durable store extends MemoryCatalogStore and treats Postgres as the
 * source of truth and the in-memory maps as a boot-time hydrated cache:
 *   - writes persist the row AND the memory copy (reads/search must never
 *     wait on the database);
 *   - at boot all rows are hydrated into memory, so /discovery reads behave
 *     identically to the memory store with zero Postgres involvement;
 *   - embedding vectors are stored alongside the row and written back as soon
 *     as the background embed completes (write-behind), so semantic search is
 *     warm immediately after a restart instead of re-embedding everything.
 *
 * Outage behaviour is degradation-with-warning, never failure: any Postgres
 * error flips the store to process-local memory and payment/catalog writes
 * proceed exactly as before. The payment path is never blocked by the catalog
 * (cataloging runs off the hot path in app.js), so an outage cannot fail or
 * delay a settlement.
 */
import { MemoryCatalogStore } from './memory.js';

/** The entry fields persisted as columns; the rest is the resource link. */
function resourceLink(entry) {
  const {
    source: _source,
    provisional: _provisional,
    expires_at: _expiresAt,
    last_seen_at: _lastSeenAt,
    first_seen_at: _firstSeenAt,
    embedding: _embedding,
    ...resource
  } = entry;
  return resource;
}

/** Rebuilds one persisted row into the in-memory entry shape. */
function hydrateRow(r) {
  const resource = typeof r.resource === 'string' ? JSON.parse(r.resource) : r.resource;
  const entry = {
    ...resource,
    source: r.source,
    provisional: r.provisional,
    // int8 columns come back from node-postgres as strings.
    expires_at: r.expires_at == null ? null : Number(r.expires_at),
    first_seen_at: new Date(r.first_seen_at),
    last_seen_at: new Date(r.last_seen_at),
  };
  if (r.embedding) {
    entry.embedding = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
  }
  return entry;
}

export class PostgresCatalogStore extends MemoryCatalogStore {
  /**
   * @param {object} config - resolved config (embeddingsUrl, catalogVerifyTtlMs,
   *   databaseUrl, …) — the same shape MemoryCatalogStore takes
   * @param {object} [options]
   * @param {object} [options.pool] - injected pg Pool (tests, or the shared
   *   Vault-managed pool #127); absent builds one from config.databaseUrl
   * @param {Function} [options.warn] - warning sink
   */
  constructor(config = {}, { pool, warn = msg => console.warn(msg) } = {}) {
    super(config);
    this.warn = warn;
    this.pool = pool ?? null;
    this.degraded = false;
    // Resolves once schema + hydration have been attempted. Never rejects: a
    // failure degrades the store instead of blocking the payment path.
    this.ready = null;
    if (this.pool) {
      this.ready = this._init();
    } else if (config.databaseUrl) {
      this.ready = import('pg')
        .then(({ default: pg }) => {
          this.pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
          this.pool.on('error', err => this._degrade(`Postgres error: ${err.message}`));
          return this._init();
        })
        .catch(err => this._degrade(`pg unavailable (${err.message}); using in-memory catalog`));
    }
  }

  _degrade(message) {
    if (!this.degraded) {
      this.degraded = true;
      this.warn(`[CatalogStore] ${message} — catalog is now process-local memory only`);
    }
  }

  async _ensureSchema() {
    if (!this.pool || this.degraded) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS catalog_resources (
            key TEXT PRIMARY KEY,
            resource JSONB NOT NULL,
            source TEXT NOT NULL,
            provisional BOOLEAN NOT NULL DEFAULT false,
            expires_at BIGINT,
            first_seen_at TIMESTAMPTZ NOT NULL,
            last_seen_at TIMESTAMPTZ NOT NULL,
            embedding JSONB
        );
        CREATE INDEX IF NOT EXISTS idx_catalog_resources_source ON catalog_resources(source);
        CREATE INDEX IF NOT EXISTS idx_catalog_resources_provisional ON catalog_resources(provisional);
      `);
    } catch (err) {
      this._degrade(`failed to create schema: ${err.message}`);
    }
  }

  async _hydrate() {
    if (!this.pool || this.degraded) return;
    const { rows } = await this.pool.query(
      `SELECT key, resource, source, provisional, expires_at, first_seen_at, last_seen_at, embedding
       FROM catalog_resources`,
    );
    for (const row of rows) {
      const entry = hydrateRow(row);
      this.resources.set(row.key, entry);
      this._incrementPayToCount(entry.payTo);
      // Rows written before embeddings existed (or an older model) are
      // re-embedded through the exact same background path new upserts use.
      if (!entry.embedding) {
        this._scheduleEmbed(entry);
      }
    }
  }

  async _init() {
    await this._ensureSchema();
    if (this.degraded) return;
    try {
      await this._hydrate();
    } catch (err) {
      this._degrade(`hydration failed: ${err.message}`);
    }
  }

  /** Upserts the durable row for an entry. Safe to call more than once: the
   *  key is stable and first_seen_at is preserved on conflict. */
  async _persistResource(entry) {
    await this.pool.query(
      `INSERT INTO catalog_resources
         (key, resource, source, provisional, expires_at, first_seen_at, last_seen_at, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO UPDATE SET
         resource = EXCLUDED.resource,
         source = EXCLUDED.source,
         provisional = EXCLUDED.provisional,
         expires_at = EXCLUDED.expires_at,
         first_seen_at = catalog_resources.first_seen_at,
         last_seen_at = EXCLUDED.last_seen_at,
         embedding = EXCLUDED.embedding`,
      [
        this._key(entry),
        JSON.stringify(resourceLink(entry)),
        entry.source ?? 'manual',
        Boolean(entry.provisional),
        entry.expires_at ?? null,
        entry.first_seen_at,
        entry.last_seen_at,
        entry.embedding ? JSON.stringify(entry.embedding) : null,
      ],
    );
  }

  /**
   * Persist a freshly-computed embedding vector as soon as it lands, so a
   * restart is warm for semantic search. Loss of a vector write must not fail
   * the embed that produced it — degrade instead.
   */
  async _afterEmbedding(entry) {
    if (this.degraded || !this.pool) return;
    try {
      await this.ready;
      await this._persistResource(entry);
    } catch (err) {
      this._degrade(`vector persist failed: ${err.message}`);
    }
  }

  async upsertResource(resource, source = 'manual') {
    // Memory first: domain rejections (the flooding guard #186) propagate
    // identically to the in-memory implementation, and the entry is visible to
    // reads/search instantly without waiting on the database.
    const entry = await super.upsertResource(resource, source);
    if (this.degraded || !this.pool) return entry;
    try {
      await this.ready;
      await this._persistResource(entry);
    } catch (err) {
      this._degrade(`upsertResource persist failed: ${err.message}`);
    }
    return entry;
  }

  async pruneExpired() {
    const expiredKeys = [];
    for (const [key, entry] of this.resources) {
      if (this._isExpired(entry)) expiredKeys.push(key);
    }
    const pruned = await super.pruneExpired();
    if (pruned > 0 && !this.degraded && this.pool) {
      try {
        await this.ready;
        await this.pool.query('DELETE FROM catalog_resources WHERE key = ANY($1)', [expiredKeys]);
      } catch (err) {
        this._degrade(`pruneExpired failed: ${err.message}`);
      }
    }
    return pruned;
  }
}

/**
 * Builds the catalog store from resolved config (#139).
 *
 * DATABASE_URL set -> Postgres-backed store (durable across restarts);
 * unset -> the in-memory store, with a loud warning that catalogued resources
 * do not survive a restart — mirroring buildSettlementStore.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @param {object} [options]
 * @param {Function} [options.log] - logging sink
 * @param {object} [options.pool] - shared pg Pool to use (a Vault-managed pool,
 *   #127); absent means the store builds its own from config.databaseUrl
 * @returns {MemoryCatalogStore|PostgresCatalogStore}
 */
export function buildCatalogStore(config = {}, { log = msg => console.warn(msg), pool } = {}) {
  if (config.databaseUrl) return new PostgresCatalogStore(config, { warn: log, pool });
  log(
    '[CatalogStore] DATABASE_URL is unset — catalog entries are stored in-memory only and not durable across restarts.',
  );
  return new MemoryCatalogStore(config);
}
