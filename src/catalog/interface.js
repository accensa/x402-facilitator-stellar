/**
 * Abstract interface contract for CatalogStore (#213).
 *
 * Every catalog store implementation (MemoryCatalogStore, PostgresCatalogStore,
 * or custom implementations) must satisfy this explicit interface contract.
 */
export class CatalogStore {
  /**
   * Monotonic catalog write version counter (#200).
   * @returns {number}
   */
  getVersion() {
    throw new Error('CatalogStore.getVersion not implemented');
  }

  /**
   * Timestamp of the most recent catalog write for Last-Modified header (#200).
   * @returns {Date}
   */
  getLastModified() {
    throw new Error('CatalogStore.getLastModified not implemented');
  }

  /**
   * Upsert a resource in the catalog.
   * @param {object} _resource
   * @param {'verify'|'settle'|'manual'|string} [_source='manual']
   * @returns {Promise<object>}
   */
  async upsertResource(_resource, _source = 'manual') {
    throw new Error('CatalogStore.upsertResource not implemented');
  }

  /**
   * Retrieve a single resource by URL and optional toolName.
   * Reaches the catalog through `GET /discovery/resource` (#222).
   * @param {string} _url
   * @param {string|null} [_toolName=null]
   * @returns {Promise<object|null>}
   */
  async getResource(_url, _toolName = null) {
    throw new Error('CatalogStore.getResource not implemented');
  }

  /**
   * Remove a resource from the catalog (#221).
   *
   * Removal is permanent and unconditional — it is the operator/seller escape
   * hatch from a listing that is wrong, hostile or simply withdrawn, so it must
   * not be routed through the provisional-expiry path (which only ever hides a
   * verify-created entry, and only until the next upsert resurrects it).
   *
   * @param {string} _url
   * @param {string|null} [_toolName=null]
   * @returns {Promise<{removed: boolean, resource: object|null}>} `removed` is
   *   false when nothing matched, so a caller can answer 404 without a second
   *   read (and without a read-then-delete race).
   */
  async deleteResource(_url, _toolName = null) {
    throw new Error('CatalogStore.deleteResource not implemented');
  }

  /**
   * List catalog resources with optional filtering and pagination.
   * @param {object} [_params={}]
   * @returns {Promise<{items: object[], total: number}>}
   */
  async listResources(_params = {}) {
    throw new Error('CatalogStore.listResources not implemented');
  }

  /**
   * Search catalog resources with query matching and optional filters.
   * @param {object} _params
   * @returns {Promise<{resources: object[], partialResults: boolean, total?: number}>}
   */
  async search(_params) {
    throw new Error('CatalogStore.search not implemented');
  }

  /**
   * Prune expired provisional resources.
   * @returns {Promise<number>} Number of pruned entries.
   */
  async pruneExpired() {
    throw new Error('CatalogStore.pruneExpired not implemented');
  }

  /**
   * Flush any in-flight background tasks (e.g. embeddings).
   * @returns {Promise<void>}
   */
  async flush() {
    throw new Error('CatalogStore.flush not implemented');
  }
}
