/**
 * Credential subscriber failures are isolated (#712).
 *
 * fetchOnce() emits fresh credentials to every subscriber right after the
 * Vault read succeeds. A subscriber (pool rotation, metrics, logging) that
 * throws used to propagate out of emit(), reject fetchOnce(), and make
 * ensureFresh() log an outage and deny credentials that were in fact fetched.
 * Each listener is now invoked inside its own try/catch and failures are
 * warned about without the credential values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseCredentialManager } from '../src/vault/creds.js';

/** A Vault-shaped credential reply; `password` must never reach a warning. */
function freshCredentials(generation = 1) {
  return {
    username: `v-user-${generation}`,
    password: `v-secret-${generation}`,
    leaseId: `lease-${generation}`,
    leaseDurationSec: 3600,
  };
}

test('a throwing subscriber does not fail an otherwise successful fetch', async () => {
  const warnings = [];
  const mgr = createDatabaseCredentialManager({
    fetchCredentials: async () => freshCredentials(),
    warn: msg => warnings.push(msg),
  });

  const notified = [];
  mgr.subscribe(() => {
    throw new Error('pool is closed');
  });
  mgr.subscribe(creds => notified.push(creds));

  const creds = await mgr.getCredentials();

  assert.equal(creds.username, 'v-user-1');
  assert.equal(creds.password, 'v-secret-1');
  assert.equal(notified.length, 1, 'the healthy subscriber was still notified');
  assert.equal(warnings.length, 1, 'the throw was reported once');
  assert.match(warnings[0], /credential subscriber failed \(pool is closed\)/);
  assert.doesNotMatch(warnings[0], /v-secret-1/);
});

test('every healthy subscriber is notified when a subscriber in the middle throws', async () => {
  const warnings = [];
  const mgr = createDatabaseCredentialManager({
    fetchCredentials: async () => freshCredentials(),
    warn: msg => warnings.push(msg),
  });

  const before = [];
  const after = [];
  mgr.subscribe(creds => before.push(creds.username));
  mgr.subscribe(() => {
    throw new Error('metrics sink unavailable');
  });
  mgr.subscribe(creds => after.push(creds.username));

  await mgr.getCredentials();

  assert.deepEqual(before, ['v-user-1']);
  assert.deepEqual(after, ['v-user-1'], 'subscribers after the throw still run');
  assert.equal(warnings.length, 1);
});

test('a later refresh resolves despite subscriber failures', async () => {
  let clock = 0;
  let generation = 0;
  const warnings = [];
  const mgr = createDatabaseCredentialManager({
    fetchCredentials: async () => freshCredentials(++generation),
    warn: msg => warnings.push(msg),
    now: () => clock,
  });

  const delivered = [];
  mgr.subscribe(() => {
    throw new Error('rotation callback blew up');
  });
  mgr.subscribe(creds => delivered.push(creds.username));

  const first = await mgr.getCredentials();
  assert.equal(first.username, 'v-user-1');

  // Move past the lease so the next call refreshes (and re-emits).
  clock += 3600 * 1000;
  const second = await mgr.getCredentials();

  assert.equal(second.username, 'v-user-2');
  assert.deepEqual(delivered, ['v-user-1', 'v-user-2']);
  assert.equal(warnings.length, 2, 'one warning per failed notification');
  assert.deepEqual(warnings, [
    '[Vault] credential subscriber failed (rotation callback blew up); continuing',
    '[Vault] credential subscriber failed (rotation callback blew up); continuing',
  ]);
});

test('a non-Error thrown value is still reported without the credentials', async () => {
  const warnings = [];
  const mgr = createDatabaseCredentialManager({
    fetchCredentials: async () => freshCredentials(),
    warn: msg => warnings.push(msg),
  });

  const failure = { message: 'subscriber exploded' };
  mgr.subscribe(() => {
    throw failure;
  });

  const creds = await mgr.getCredentials();
  assert.equal(creds.username, 'v-user-1');
  assert.match(warnings[0], /subscriber exploded/);
  assert.doesNotMatch(warnings[0], /v-secret-1/);
});

test('unsubscribing a throwing listener stops the warning', async () => {
  let clock = 0;
  const warnings = [];
  const mgr = createDatabaseCredentialManager({
    fetchCredentials: async () => freshCredentials(),
    warn: msg => warnings.push(msg),
    now: () => clock,
  });

  const unsubscribe = mgr.subscribe(() => {
    throw new Error('removed listener');
  });

  await mgr.getCredentials();
  assert.equal(warnings.length, 1);

  unsubscribe();
  clock += 3600 * 1000;
  const creds = await mgr.getCredentials();
  assert.equal(creds.username, 'v-user-1');
  assert.equal(warnings.length, 1, 'no notification after unsubscribe');
});
