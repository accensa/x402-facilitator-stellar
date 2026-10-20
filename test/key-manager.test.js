import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyManager, keyId } from '../src/key-manager.js';

// Real ed25519 seed fixtures: normaliseKeys validates each key with a
// checksum-aware StrKey decode (#498), so an "S"-prefixed placeholder is no
// longer a valid input.
const first = 'SAO2MAIQCR5T27QDICO3QJTD2YZ4PMEAVLCLQ6AANVGPCZ53TEACPDOQ';
const second = 'SDKL5BFVNLUCIP64CY3ZXSEAOQYJ7YNG35OKBFUW5QEZNZRKV6Q5DER6';

/** 56 chars starting with S, but the last base32 digit breaks the StrKey checksum. */
const badChecksum = `${first.slice(0, 55)}${first[55] === 'A' ? 'B' : 'A'}`;

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

test('KeyManager rejects a bad-checksum seed before creating a generation (#498)', () => {
  let error;
  try {
    new KeyManager({
      network: 'stellar:testnet',
      secrets: [badChecksum],
      createSigner: signer,
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'the constructor must reject the key before installing a generation');
  assert.match(error.message, /invalid Stellar secret key/);
  assert.ok(!error.message.includes(badChecksum), 'the error must not echo the secret material');
});

test('KeyManager rejects a wrongly-prefixed seed (wrong StrKey version) (#498)', () => {
  // A public key shares the 56-character StrKey shape but not the seed version
  // byte, so the old first-character test could not tell them apart.
  const wrongVersion = 'GAZILSAJN5CE5KZWBNTUTWF7TTFIMJ3BSBCBUIVR56QKBGW3BPSIZ2TW';
  assert.throws(
    () =>
      new KeyManager({
        network: 'stellar:testnet',
        secrets: [wrongVersion],
        createSigner: signer,
      }),
    /invalid Stellar secret key/,
  );
});

test('KeyManager refresh rejects a malformed key before installing a generation (#498)', async () => {
  const manager = new KeyManager({
    network: 'stellar:testnet',
    secrets: [first],
    loadKeys: async () => [badChecksum],
    createSigner: signer,
  });

  await assert.rejects(() => manager.refresh(), /invalid Stellar secret key/);
  assert.equal(manager.generations.size, 1, 'a corrupt key source must not create a generation');
});
