import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseCredentialManager } from '../src/vault/creds.js';

test('failed refresh returns a cached lease that has not expired', async () => {
  let clock = 0;
  let fetches = 0;
  const warnings = [];
  const manager = createDatabaseCredentialManager({
    fetchCredentials: async () => {
      fetches++;
      if (fetches > 1) throw new Error('Vault unavailable');
      return { username: 'db-user', password: 'secret', leaseDurationSec: 60 };
    },
    warn: message => warnings.push(message),
    now: () => clock,
  });

  const original = await manager.getCredentials();
  clock = 59_000;
  const fallback = await manager.getCredentials();

  assert.strictEqual(fallback, original);
  assert.match(warnings[0], /using valid cached credentials/);
});

test('failed refresh rejects instead of returning an expired cached lease', async () => {
  let clock = 0;
  let fetches = 0;
  const warnings = [];
  const manager = createDatabaseCredentialManager({
    fetchCredentials: async () => {
      fetches++;
      if (fetches > 1) throw new Error('Vault unavailable');
      return { username: 'db-user', password: 'secret', leaseDurationSec: 5 };
    },
    warn: message => warnings.push(message),
    now: () => clock,
  });

  await manager.getCredentials();
  clock = 5_000;
  await assert.rejects(() => manager.getCredentials(), /Vault unavailable/);
  assert.match(warnings[0], /no unexpired cached credentials/);
});
