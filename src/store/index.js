import { MemorySettlementStore } from './memory.js';
import { PostgresSettlementStore } from './postgres.js';

/**
 * Builds the settlement store based on configuration (#10).
 *
 * If `DATABASE_URL` is configured, returns a `PostgresSettlementStore`.
 * Otherwise returns a `MemorySettlementStore` and logs loudly that settlements
 * are stored in-memory only and not durable across process restarts.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @param {object} [options]
 * @param {Function} [options.log] - logging sink
 * @param {object} [options.pool] - shared pg Pool to use (a Vault-managed pool,
 *   #127); absent means the store builds its own from databaseUrl
 * @returns {MemorySettlementStore|PostgresSettlementStore}
 */
export function buildSettlementStore(config, { log = msg => console.warn(msg), pool } = {}) {
  if (config?.databaseUrl) {
    return new PostgresSettlementStore(config.databaseUrl, { warn: log, pool });
  }

  log(
    '[SettlementStore] DATABASE_URL is unset — settlements are stored in-memory only and not durable across restarts!',
  );
  return new MemorySettlementStore();
}

export { MemorySettlementStore, PostgresSettlementStore };
