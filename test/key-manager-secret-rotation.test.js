import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyManager } from '../src/key-manager.js';

const first = 'SAO2MAIQCR5T27QDICO3QJTD2YZ4PMEAVLCLQ6AANVGPCZ53TEACPDOQ';
const second = 'SDKL5BFVNLUCIP64CY3ZXSEAOQYJ7YNG35OKBFUW5QEZNZRKV6Q5DER6';

function signer(secret, network) {
  return { address: `${network}:${secret[1]}`, secretHash: secret };
}

test('KeyManager detects secret rotation when explicit kid is unchanged', async () => {
  let keys = [{ kid: 'primary-signer', secret: first }];
  const manager = new KeyManager({
    network: 'stellar:testnet',
    secrets: keys,
    loadKeys: async () => keys,
    createSigner: signer,
  });

  const originalGen = manager.currentGeneration;
  assert.deepEqual(manager.getActiveKeyIds(), ['primary-signer']);
  const initialSigner = manager.getCurrent().entries.get('primary-signer').signer;

  // Refresh with identical secret and kid returns false
  assert.equal(await manager.refresh(), false);
  assert.equal(manager.currentGeneration, originalGen);

  // Rotate secret under the same kid 'primary-signer'
  keys = [{ kid: 'primary-signer', secret: second }];
  const refreshed = await manager.refresh();
  assert.equal(refreshed, true);
  assert.equal(manager.currentGeneration, originalGen + 1);

  // Active key ID unchanged, but signer is updated
  assert.deepEqual(manager.getActiveKeyIds(), ['primary-signer']);
  const updatedSigner = manager.getCurrent().entries.get('primary-signer').signer;
  assert.notDeepEqual(initialSigner, updatedSigner);
});
