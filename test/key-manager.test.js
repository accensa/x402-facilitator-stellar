import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyManager, keyId } from '../src/key-manager.js';

const first = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const second = 'SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function signer(secret, network) {
  return { address: `${network}:${secret[1]}` };
}

test('KeyManager derives stable key IDs and rotates without purging leased generations', async () => {
  let keys = [first];
  const manager = new KeyManager({
    network: 'stellar:testnet',
    secrets: keys,
    loadKeys: async () => keys,
    createSigner: signer,
  });

  const original = manager.snapshot();
  assert.deepEqual(manager.getActiveKeyIds(), [keyId(first)]);

  keys = [second];
  assert.equal(await manager.refresh(), true);
  assert.deepEqual(manager.getActiveKeyIds(), [keyId(second)]);
  assert.equal(manager.generations.size, 2);

  manager.retirementGraceMs = 0;
  original.release();
  assert.equal(manager.generations.size, 1);
  assert.equal(await manager.refresh(), false);
});

test('KeyManager rejects invalid and duplicate keys', () => {
  assert.throws(
    () =>
      new KeyManager({
        network: 'stellar:testnet',
        secrets: ['not-a-secret'],
        createSigner: signer,
      }),
    /invalid Stellar secret key/,
  );

  assert.throws(
    () =>
      new KeyManager({
        network: 'stellar:testnet',
        secrets: [
          { kid: 'same', secret: first },
          { kid: 'same', secret: second },
        ],
        createSigner: signer,
      }),
    /duplicate kid/,
  );
});
