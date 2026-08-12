/**
 * resolveConfig / resolveNetworks.
 *
 * Both take an env object rather than reading process.env, which is what makes
 * them testable at all — and is the reason a misconfiguration fails at boot
 * rather than on the first payment.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, resolveNetworks, TESTNET, PUBNET } from '../src/config.js';

/** A minimal valid environment. Tests override single keys off this. */
const BASE = { FACILITATOR_SECRET: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };

describe('resolveConfig — the secret', () => {
  test('a missing secret throws, and the message says how to make one', () => {
    assert.throws(
      () => resolveConfig({}),
      err => {
        assert.match(err.message, /FACILITATOR_SECRET is required/);
        // The hint matters more than the error: a first-run operator has no
        // idea where an S... key comes from.
        assert.match(err.message, /stellar keys generate facilitator/);
        return true;
      },
    );
  });

  test('a secret that is not an S... key is rejected', () => {
    // A public key is the mistake people actually make, not random junk.
    assert.throws(
      () => resolveConfig({ FACILITATOR_SECRET: 'GABCDEF' }),
      /must be a Stellar secret key \(starts with S\)/,
    );
  });

  test('an S... key is accepted', () => {
    assert.equal(resolveConfig(BASE).secret, BASE.FACILITATOR_SECRET);
  });
});

describe('resolveNetworks — pubnet is opt-in and needs its own signer', () => {
  test('defaults to testnet only', () => {
    assert.deepEqual(resolveNetworks({}), [TESTNET]);
  });

  test('ENABLE_PUBNET without a pubnet secret refuses, naming the risk', () => {
    assert.throws(
      () => resolveNetworks({ ENABLE_PUBNET: 'true' }),
      err => {
        assert.match(err.message, /FACILITATOR_SECRET_PUBNET is unset/);
        // Refusing is the point: serving pubnet with the testnet signer loses
        // real money, so the message has to say that rather than just fail.
        assert.match(err.message, /Refusing to serve pubnet with the testnet signer/);
        return true;
      },
    );
  });

  test('ENABLE_PUBNET with a pubnet secret serves both networks', () => {
    assert.deepEqual(
      resolveNetworks({ ENABLE_PUBNET: 'true', FACILITATOR_SECRET_PUBNET: 'SPUB' }),
      [TESTNET, PUBNET],
    );
  });

  test('only the exact string "true" opts in — not "1", "yes" or "TRUE"', () => {
    // A loose truthiness check here would let a typo enable mainnet.
    for (const value of ['1', 'yes', 'TRUE', 'True', '']) {
      assert.deepEqual(
        resolveNetworks({ ENABLE_PUBNET: value, FACILITATOR_SECRET_PUBNET: 'SPUB' }),
        [TESTNET],
        `ENABLE_PUBNET=${JSON.stringify(value)} must not enable pubnet`,
      );
    }
  });
});

describe('resolveConfig — defaults', () => {
  test('port defaults to 3402 and is read from PORT', () => {
    assert.equal(resolveConfig(BASE).port, 3402);
    assert.equal(resolveConfig({ ...BASE, PORT: '8080' }).port, 8080);
  });

  test('the fee ceiling defaults to 50000 stroops and is configurable', () => {
    assert.equal(resolveConfig(BASE).maxTransactionFeeStroops, 50_000);
    assert.equal(
      resolveConfig({ ...BASE, MAX_TX_FEE_STROOPS: '120000' }).maxTransactionFeeStroops,
      120_000,
    );
  });

  test('rpcUrl is undefined unless set, so the package default applies', () => {
    assert.equal(resolveConfig(BASE).rpcUrl, undefined);
    assert.equal(
      resolveConfig({ ...BASE, STELLAR_RPC_URL: 'https://rpc.example' }).rpcUrl,
      'https://rpc.example',
    );
  });
});

describe('resolveConfig — API keys', () => {
  test('unset means open, represented as an empty list', () => {
    assert.deepEqual(resolveConfig(BASE).apiKeys, []);
  });

  test('keys are split, trimmed, and empty entries dropped', () => {
    assert.deepEqual(
      resolveConfig({ ...BASE, FACILITATOR_API_KEYS: ' k1 , k2,,  k3  ,' }).apiKeys,
      ['k1', 'k2', 'k3'],
    );
  });

  test('a value of only separators and whitespace is open, not a key of ""', () => {
    // An empty-string key would authenticate a request presenting no key.
    assert.deepEqual(resolveConfig({ ...BASE, FACILITATOR_API_KEYS: ' , , ' }).apiKeys, []);
  });
});
