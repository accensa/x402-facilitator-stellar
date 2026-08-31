import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { resolveConfig } from '../src/config.js';
import { buildFacilitator } from '../src/facilitator.js';

const first = Keypair.random();
const second = Keypair.random();

test('buildFacilitator exposes independently rotatable key managers', async () => {
  const config = resolveConfig({
    FACILITATOR_SECRET: first.secret(),
    KEY_MANAGER_POLL_INTERVAL_MS: '0',
  });
  const built = buildFacilitator(config);
  const manager = built.keyManagers['stellar:testnet'];

  assert.deepEqual(built.signers['stellar:testnet'], [first.publicKey()]);
  assert.equal(manager.getActiveKeyIds().length, 1);

  let refreshed = false;
  manager.loadKeys = async () => [second.secret()];
  manager.onRefresh = async () => {
    refreshed = true;
  };
  assert.equal(await manager.refresh(), true);
  assert.equal(refreshed, true);
  assert.deepEqual(manager.getActiveKeyIds().length, 1);
  assert.equal(
    manager.getCurrent().entries.values().next().value.signer.address,
    second.publicKey(),
  );
});
