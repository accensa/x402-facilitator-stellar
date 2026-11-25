import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseCredentialManager } from '../src/vault/creds.js';

test('concurrent credential requests share one Vault refresh', async () => {
  let resolveFetch;
  let fetches = 0;
  const manager = createDatabaseCredentialManager({
    fetchCredentials: () => {
      fetches++;
      return new Promise(resolve => {
        resolveFetch = resolve;
      });
    },
  });

  const pending = Array.from({ length: 10 }, () => manager.getCredentials());
  assert.equal(fetches, 1);
  resolveFetch({ username: 'db-user', password: 'secret', leaseDurationSec: 60 });

  const credentials = await Promise.all(pending);
  assert.equal(fetches, 1);
  assert.ok(credentials.every(value => value === credentials[0]));
});

test('a failed shared refresh clears its promise for the next attempt', async () => {
  let fetches = 0;
  const manager = createDatabaseCredentialManager({
    fetchCredentials: async () => {
      fetches++;
      if (fetches === 1) throw new Error('Vault unavailable');
      return { username: 'db-user', password: 'secret', leaseDurationSec: 60 };
    },
    warn: () => {},
  });

  const failures = await Promise.allSettled(
    Array.from({ length: 5 }, () => manager.getCredentials()),
  );
  assert.equal(fetches, 1);
  assert.ok(failures.every(result => result.status === 'rejected'));

  const credentials = await manager.getCredentials();
  assert.equal(fetches, 2);
  assert.equal(credentials.username, 'db-user');
});
