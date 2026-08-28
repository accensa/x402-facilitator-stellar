/**
 * HashiCorp Vault integration (#127).
 *
 * Under test: AppRole authentication and token lease handling, dynamic
 * database credentials read from the database secrets engine, lease-cached
 * rotation with graceful outage behaviour, the pool that applies rotated
 * credentials, and the config validation that refuses unsafe Vault setups.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { createDatabaseCredentialManager } from '../src/vault/creds.js';
import { createVaultClient } from '../src/vault/client.js';
import { createVaultManagedDatabase } from '../src/vault/database.js';
import { resolveConfig } from '../src/config.js';

/** node-vault-shaped double: AppRole login + read, with call recording. */
function fakeNodeVault({ readResult } = {}) {
  const calls = [];
  let readCount = 0;
  const factory = opts => {
    calls.push({ type: 'create', opts });
    return {
      token: null,
      async approleLogin({ role_id, secret_id }) {
        calls.push({ type: 'login', role_id, secret_id });
        return { auth: { client_token: 'tok-1', lease_duration: 600 } };
      },
      async read(path) {
        calls.push({ type: 'read', path });
        readCount++;
        // A denied path fails exactly once, so the retry-after-relogin path
        // can be exercised (the second read succeeds).
        if (path.includes('denied') && readCount === 1) {
          throw Object.assign(new Error('permission denied'), { response: { statusCode: 403 } });
        }
        const overrides =
          typeof readResult === 'function' ? readResult(readCount, path) : (readResult ?? {});
        return {
          data: { username: 'v-user', password: 'v-pass', ...overrides.data },
          lease_id: overrides.leaseId ?? 'lease-1',
          lease_duration: overrides.leaseDurationSec ?? 3600,
          renewable: true,
        };
      },
    };
  };
  factory.calls = calls;
  return factory;
}

describe('createDatabaseCredentialManager (#127)', () => {
  test('fetches on first demand and caches until the renewal window', async () => {
    let clock = 0;
    let fetches = 0;
    const mgr = createDatabaseCredentialManager({
      fetchCredentials: async () => {
        fetches++;
        return { username: 'u', password: 'p', leaseDurationSec: 3600 };
      },
      now: () => clock,
    });

    const first = await mgr.getCredentials();
    assert.equal(first.username, 'u');
    assert.equal(fetches, 1);

    // 30 minutes in: remaining (30min) is well inside the lease -> cached.
    clock += 30 * 60 * 1000;
    const second = await mgr.getCredentials();
    assert.equal(second, first);
    assert.equal(fetches, 1, 'cached within the renewal window');
  });

  test('refreshes before expiry and notifies subscribers (pool rotation)', async () => {
    let clock = 0;
    let generation = 0;
    const mgr = createDatabaseCredentialManager({
      fetchCredentials: async () => {
        generation++;
        return { username: `u${generation}`, password: `p${generation}`, leaseDurationSec: 5 };
      },
      now: () => clock,
    });
    const rotated = [];
    mgr.subscribe(c => rotated.push(c));

    await mgr.getCredentials();
    assert.equal(rotated.length, 1);

    // 5s lease, refresh window = max(2000, min(1500, 60000)) = 2000ms.
    // 4s in -> 1s remaining -> refresh.
    clock += 4000;
    const fresh = await mgr.getCredentials();
    assert.equal(fresh.username, 'u2');
    assert.equal(rotated.length, 2, 'subscriber sees the rotated credentials');
  });

  test('a Vault outage during the lease returns the cached credentials', async () => {
    let clock = 0;
    let fail = false;
    const mgr = createDatabaseCredentialManager({
      fetchCredentials: async () => {
        if (fail) throw new Error('connection refused');
        return { username: 'u', password: 'p', leaseDurationSec: 60 };
      },
      warn: () => {},
      now: () => clock,
    });

    await mgr.getCredentials();
    fail = true;
    // Well inside the lease: the cached pair must come back, not an error.
    clock += 10_000;
    const cached = await mgr.getCredentials();
    assert.equal(cached.username, 'u');
    assert.equal(cached.password, 'p');
  });

  test('throws only when there is no cached lease and the fetch fails', async () => {
    const mgr = createDatabaseCredentialManager({
      fetchCredentials: async () => {
        throw new Error('vault down at boot');
      },
      warn: () => {},
    });
    await assert.rejects(() => mgr.getCredentials(), /vault down at boot/);
  });

  test('static roles (lease 0) are never rotated', async () => {
    let clock = 0;
    let fetches = 0;
    const mgr = createDatabaseCredentialManager({
      fetchCredentials: async () => {
        fetches++;
        return { username: 'u', password: 'p', leaseDurationSec: 0 };
      },
      now: () => clock,
    });
    await mgr.getCredentials();
    clock += 24 * 60 * 60 * 1000;
    await mgr.getCredentials();
    assert.equal(fetches, 1, 'non-expiring lease is fetched once');
  });

  test('stop clears the refresh timer', async () => {
    const mgr = createDatabaseCredentialManager({
      fetchCredentials: async () => ({ username: 'u', password: 'p', leaseDurationSec: 60 }),
      now: () => Date.now(),
    });
    mgr.start();
    mgr.stop();
    mgr.stop(); // idempotent
    assert.doesNotThrow(async () => mgr.getCredentials());
  });
});

describe('createVaultClient — AppRole + database creds (#127)', () => {
  test('readDatabaseCredentials parses the database secrets engine response', async () => {
    const vault = fakeNodeVault();
    const client = createVaultClient({
      address: 'http://vault:8200',
      roleId: 'role-1',
      secretId: 'secret-1',
      nodeVault: vault,
    });

    const creds = await client.readDatabaseCredentials({ mount: 'database', role: 'facilitator' });
    assert.equal(creds.username, 'v-user');
    assert.equal(creds.password, 'v-pass');
    assert.equal(creds.leaseId, 'lease-1');
    assert.equal(creds.leaseDurationSec, 3600);
    assert.equal(creds.renewable, true);

    const login = vault.calls.find(c => c.type === 'login');
    assert.deepEqual(login, { type: 'login', role_id: 'role-1', secret_id: 'secret-1' });
    const read = vault.calls.find(c => c.type === 'read');
    assert.equal(read.path, 'database/creds/facilitator');
  });

  test('re-authenticates once when the read is denied with 403', async () => {
    const vault = fakeNodeVault();
    const client = createVaultClient({
      address: 'http://vault:8200',
      roleId: 'role-1',
      secretId: 'secret-1',
      nodeVault: vault,
      now: () => 0,
    });

    // The first read is denied; the retry succeeds.
    const creds = await client.readDatabaseCredentials({ mount: 'database', role: 'denied-role' });
    assert.equal(creds.username, 'v-user');
    const logins = vault.calls.filter(c => c.type === 'login');
    assert.equal(logins.length, 2, 'one login for the first attempt, one after the 403');
  });

  test('a non-auth failure is not retried', async () => {
    const vault = fakeNodeVault({
      readResult: () => {
        throw Object.assign(new Error('bad gateway'), { response: { statusCode: 502 } });
      },
    });
    const client = createVaultClient({
      address: 'http://vault:8200',
      roleId: 'r',
      secretId: 's',
      nodeVault: vault,
    });
    await assert.rejects(
      () => client.readDatabaseCredentials({ mount: 'database', role: 'x' }),
      /bad gateway/,
    );
    assert.equal(vault.calls.filter(c => c.type === 'login').length, 1);
  });
});

describe('createVaultManagedDatabase (#127)', () => {
  class FakePool {
    constructor(options) {
      this.options = options;
      this.ended = 0;
    }
    async end() {
      this.ended++;
    }
  }

  test('builds a pool with the initial Vault credentials and rotates them', async () => {
    let clock = 0;
    let generation = 0;
    const vault = fakeNodeVault({
      readResult: () => {
        generation++;
        return {
          data: { username: `v-user-${generation}`, password: `v-pass-${generation}` },
          leaseDurationSec: 5,
        };
      },
    });
    const warns = [];
    const logs = [];

    const db = await createVaultManagedDatabase({
      vault: {
        address: 'http://vault:8200',
        roleId: 'r',
        secretId: 's',
        dbMount: 'database',
        dbRole: 'facilitator',
        pollIntervalMs: 10_000,
      },
      databaseUrl: 'postgres://db.internal:5432/x402',
      nodeVault: vault,
      Pool: FakePool,
      warn: m => warns.push(m),
      log: m => logs.push(m),
      now: () => clock,
    });

    assert.ok(db.pool, 'pool exists after a successful boot fetch');
    assert.equal(db.pool.options.user, 'v-user-1');
    assert.equal(db.pool.options.password, 'v-pass-1');
    assert.equal(db.pool.options.connectionString, 'postgres://db.internal:5432/x402');

    // Advance past the renewal window; the manager refreshes and the pool's
    // options follow, so NEW pg connections use the rotated credentials.
    clock += 4000;
    const rotated = await db.creds.getCredentials();
    assert.equal(rotated.username, 'v-user-2');
    assert.equal(db.pool.options.user, 'v-user-2');
    assert.equal(db.pool.options.password, 'v-pass-2');

    await db.stop();
    assert.equal(db.pool.ended, 1);
  });

  test('a boot-time Vault outage degrades to no pool, with a warning', async () => {
    const warns = [];
    const db = await createVaultManagedDatabase({
      vault: {
        address: 'http://vault:8200',
        roleId: 'r',
        secretId: 's',
        dbMount: 'database',
        dbRole: 'facilitator',
        pollIntervalMs: 10_000,
      },
      databaseUrl: 'postgres://db.internal:5432/x402',
      nodeVault: fakeNodeVault({
        readResult: () => {
          throw Object.assign(new Error('connection refused'), { response: { statusCode: 502 } });
        },
      }),
      Pool: FakePool,
      warn: m => warns.push(m),
      bootTimeoutMs: 1000,
    });

    assert.equal(db.pool, null, 'no pool when the first fetch fails');
    assert.ok(
      warns.some(w => w.includes('[Vault]')),
      'the outage is logged loudly',
    );
    await db.stop();
  });

  test('rotated credentials never appear in logs or warnings', async () => {
    const logs = [];
    const warns = [];
    let generation = 0;
    const vault = fakeNodeVault({
      readResult: () => {
        generation++;
        return {
          data: { username: `u${generation}`, password: `supersecret${generation}` },
          leaseDurationSec: 5,
        };
      },
    });
    const db = await createVaultManagedDatabase({
      vault: {
        address: 'http://vault:8200',
        roleId: 'r',
        secretId: 's',
        dbMount: 'database',
        dbRole: 'facilitator',
        pollIntervalMs: 10_000,
      },
      databaseUrl: 'postgres://db.internal:5432/x402',
      nodeVault: vault,
      Pool: FakePool,
      warn: m => warns.push(m),
      log: m => logs.push(m),
      now: () => Date.now(),
    });
    // Force a refresh cycle so rotation logging fires.
    await db.creds.getCredentials();
    await db.stop();

    const all = [...logs, ...warns].join('\n');
    assert.ok(!/supersecret/.test(all), 'the password must never reach logs or warnings');
    assert.ok(
      logs.some(l => l.includes('[Vault]')),
      'rotation is still observable',
    );
  });
});

describe('config validation for Vault (#127)', () => {
  const baseEnv = { FACILITATOR_SECRET: Keypair.random().secret() };

  test('VAULT_ADDR requires role id and secret id', () => {
    assert.throws(
      () =>
        resolveConfig({
          ...baseEnv,
          VAULT_ADDR: 'http://vault:8200',
          DATABASE_URL: 'postgres://db:5432/x',
        }),
      /VAULT_APPROLE_ROLE_ID and VAULT_APPROLE_SECRET_ID are not/,
    );
  });

  test('VAULT_ADDR refuses a DATABASE_URL with embedded userinfo', () => {
    assert.throws(
      () =>
        resolveConfig({
          ...baseEnv,
          VAULT_ADDR: 'http://vault:8200',
          VAULT_APPROLE_ROLE_ID: 'r',
          VAULT_APPROLE_SECRET_ID: 's',
          DATABASE_URL: 'postgres://user:pass@db:5432/x',
        }),
      /must not embed credentials when VAULT_ADDR is set/,
    );
  });

  test('VAULT_ADDR requires DATABASE_URL', () => {
    assert.throws(
      () =>
        resolveConfig({
          ...baseEnv,
          VAULT_ADDR: 'http://vault:8200',
          VAULT_APPROLE_ROLE_ID: 'r',
          VAULT_APPROLE_SECRET_ID: 's',
        }),
      /VAULT_ADDR is set but DATABASE_URL is not/,
    );
  });

  test('a complete Vault config resolves with defaults', () => {
    const config = resolveConfig({
      ...baseEnv,
      VAULT_ADDR: 'http://vault:8200',
      VAULT_APPROLE_ROLE_ID: 'role-1',
      VAULT_APPROLE_SECRET_ID: 'secret-1',
      DATABASE_URL: 'postgres://db:5432/x402',
      VAULT_NAMESPACE: 'team-a',
    });
    assert.deepEqual(config.vault, {
      address: 'http://vault:8200',
      namespace: 'team-a',
      roleId: 'role-1',
      secretId: 'secret-1',
      dbMount: 'database',
      dbRole: 'facilitator',
      pollIntervalMs: 10_000,
    });
  });

  test('vault is null when VAULT_ADDR is unset (zero-config unchanged)', () => {
    const config = resolveConfig({ ...baseEnv, DATABASE_URL: 'postgres://u:p@db:5432/x' });
    assert.equal(config.vault, null);
  });
});
