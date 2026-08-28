/**
 * Vault-managed Postgres pool (#127).
 *
 * Builds a pg Pool whose credentials come from Vault's database secrets
 * engine and are rotated as the lease approaches expiry, instead of a
 * long-lived password embedded in DATABASE_URL.
 *
 * ROTATION. pg creates each new client from the pool's live `options` object
 * (`new Client(this.options)`), so swapping `pool.options.user/password` when
 * the credential manager refreshes means every NEW connection authenticates
 * with the fresh credentials while existing connections simply keep running.
 * This only works when DATABASE_URL carries no userinfo — enforced at boot by
 * config.js — because pg lets a connection string override explicit userinfo.
 *
 * OUTAGE HANDLING. The credential manager caches the lease (see creds.js):
 * a Vault outage during the lease window returns the cached credentials, so
 * the pool keeps working. Only a boot-time failure with no cached lease
 * degrades: the service starts without a database-backed pool and each store
 * falls back to its documented degrade path (memory, or fail-closed for the
 * shared rate limiter).
 */
import { createRequire } from 'node:module';
import { createVaultClient } from './client.js';
import { createDatabaseCredentialManager } from './creds.js';

const require = createRequire(import.meta.url);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} options
 * @param {object} options.vault - resolved vault config (config.vault)
 * @param {string} options.databaseUrl - postgres://host:port/db WITHOUT userinfo
 * @param {Function} [options.nodeVault] - node-vault factory (injectable for tests)
 * @param {object} [options.Pool] - pg Pool class (injectable for tests)
 * @param {(msg: string) => void} [options.warn]
 * @param {(msg: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.bootTimeoutMs] - cap on the initial credential fetch
 * @returns {Promise<{pool: object|null, creds: object|null, stop: Function}>}
 */
export async function createVaultManagedDatabase({
  vault,
  databaseUrl,
  nodeVault,
  Pool,
  warn = msg => console.warn(msg),
  log = () => {},
  now = () => Date.now(),
  bootTimeoutMs = 10_000,
}) {
  const client = createVaultClient({ ...vault, nodeVault, now });
  const creds = createDatabaseCredentialManager({
    fetchCredentials: () =>
      client.readDatabaseCredentials({ mount: vault.dbMount, role: vault.dbRole }),
    pollIntervalMs: vault.pollIntervalMs,
    warn,
    now,
  });

  let pool = null;
  try {
    const initial = await withTimeout(
      creds.getCredentials(),
      bootTimeoutMs,
      'initial Vault credential fetch',
    );

    const { Pool: PgPool } = Pool ? { Pool } : require('pg');
    pool = new PgPool({
      connectionString: databaseUrl,
      user: initial.username,
      password: initial.password,
      max: 5,
    });

    creds.subscribe(rotated => {
      if (!pool) return;
      pool.options.user = rotated.username;
      pool.options.password = rotated.password;
      log('[Vault] database credentials rotated for the next pool connections');
    });
    creds.start();
    log(
      `[Vault] database credentials obtained from ${vault.address} (role ${vault.dbMount}/creds/${vault.dbRole})`,
    );

    return {
      pool,
      creds,
      stop: async () => {
        creds.stop();
        await pool.end().catch(() => {});
      },
    };
  } catch (err) {
    creds.stop();
    warn(
      `[Vault] ${err.message} — starting without a database-backed pool; stores will use their degrade paths`,
    );
    return { pool: null, creds: null, stop: async () => {} };
  }
}
