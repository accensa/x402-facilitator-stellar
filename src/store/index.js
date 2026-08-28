import { MemorySettlementStore } from './memory.js';
import { PostgresSettlementStore } from './postgres.js';

/**
 * Builds the settlement store based on configuration (#10).
 *
 * If `DATABASE_URL` is configured, returns a `PostgresSettlementStore`.
 * Otherwise returns a `MemorySettlementStore` and logs loudly that settlements
 * are stored in-memory only and not durable across process restarts.
 *
 * CQRS (#121): when `DATABASE_URL_REPLICA` is also set, the store splits read
 * and write concerns — writes hit the primary, status reads and the
 * reconciliation sweep hit the read replica, with `SETTLEMENT_REPLICA_LAG_MS`
 * bounding the read-after-write staleness window.
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
    // CQRS (#121): when a read replica is configured, split reads from writes.
    return new PostgresSettlementStore(config.databaseUrl, {
      warn: log,
      pool,
      replicaUrl: config.databaseReplicaUrl ?? null,
      replicaLagMs: config.settlementReplicaLagMs ?? 1000,
    });
  }

  log(
    '[SettlementStore] DATABASE_URL is unset — settlements are stored in-memory only and not durable across restarts!',
  );
  return new MemorySettlementStore();
}

export { MemorySettlementStore, PostgresSettlementStore };
