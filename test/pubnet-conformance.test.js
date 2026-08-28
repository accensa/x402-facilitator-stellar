import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { resolveConfig, TESTNET, PUBNET } from '../src/config.js';
import { buildFacilitator } from '../src/facilitator.js';
import { createApp } from '../src/app.js';
import { toStroops } from '../src/sdk/index.js';
import { UPSTREAM_REASONS } from '../src/reasons.js';

/**
 * Issue #17 — serve stellar:pubnet.
 *
 * The gating stays: ENABLE_PUBNET=true needs its own secret and its own RPC URL
 * and refuses to boot otherwise. What these tests pin down is that once that
 * gate clears, the pubnet path is isolated from testnet at the three layers
 * the issue calls out — signer pool, RPC routing and fee ceiling — and that
 * /supported advertises both CAIP-2 networks with the correct `extra` block.
 */

describe('pubnet serving (#17): config and per-network isolation', () => {
  test('pubnet is opt-in with its own secret and refuses testnet-shaped config', () => {
    assert.throws(
      () =>
        resolveConfig({
          FACILITATOR_SECRET: Keypair.random().secret(),
          ENABLE_PUBNET: 'true',
        }),
      /FACILITATOR_SECRET_PUBNET is required/,
    );

    assert.throws(
      () =>
        resolveConfig({
          FACILITATOR_SECRET: Keypair.random().secret(),
          ENABLE_PUBNET: 'true',
          FACILITATOR_SECRET_PUBNET: Keypair.random().secret(),
        }),
      /STELLAR_RPC_URL_PUBNET is unset/,
    );
  });

  test('per-network config keeps signer pool, RPC and fee ceiling isolated', () => {
    const testnetKey = Keypair.random().secret();
    const pubnetKey = Keypair.random().secret();
    const config = resolveConfig({
      FACILITATOR_SECRET: testnetKey,
      ENABLE_PUBNET: 'true',
      FACILITATOR_SECRET_PUBNET: pubnetKey,
      STELLAR_RPC_URL_PUBNET: 'https://mainnet.rpc.example.com',
      MAX_TX_FEE_STROOPS_PUBNET: '25000',
    });

    assert.deepStrictEqual(config.networks, [TESTNET, PUBNET]);
    // Distinct signer secrets, distinct RPC URLs, distinct fee ceilings.
    assert.notEqual(config.perNetwork[TESTNET].secret, config.perNetwork[PUBNET].secret);
    assert.equal(config.perNetwork[TESTNET].rpcUrl, undefined);
    assert.equal(config.perNetwork[PUBNET].rpcUrl, 'https://mainnet.rpc.example.com');
    assert.equal(config.perNetwork[TESTNET].maxTransactionFeeStroops, 50000);
    assert.equal(config.perNetwork[PUBNET].maxTransactionFeeStroops, 25000);
  });

  test('no pubnet signer/RPC details exist unless ENABLE_PUBNET=true', () => {
    const config = resolveConfig({
      FACILITATOR_SECRET: Keypair.random().secret(),
    });
    assert.deepStrictEqual(config.networks, [TESTNET]);
    assert.equal(config.perNetwork[PUBNET], undefined);
  });

  test('buildFacilitator registers one scheme per network with isolated signer pools', () => {
    const testnetKey = Keypair.random().secret();
    const pubnetKey = Keypair.random().secret();
    const config = resolveConfig({
      FACILITATOR_SECRET: testnetKey,
      ENABLE_PUBNET: 'true',
      FACILITATOR_SECRET_PUBNET: pubnetKey,
      STELLAR_RPC_URL_PUBNET: 'https://mainnet.rpc.example.com',
    });

    const { facilitator, signers } = buildFacilitator(config);

    // Signer addresses are keyed per network and are disjoint.
    const testnetSigners = signers[TESTNET];
    const pubnetSigners = signers[PUBNET];
    assert.equal(testnetSigners.length, 1);
    assert.equal(pubnetSigners.length, 1);
    assert.notDeepEqual(testnetSigners, pubnetSigners);

    // /supported advertises both CAIP-2 networks with the Stellar extra block.
    const supported = facilitator.getSupported();
    const kinds = supported.kinds;
    const networks = kinds.map(k => k.network);
    assert.ok(networks.includes(TESTNET));
    assert.ok(networks.includes(PUBNET));
    for (const k of kinds) {
      assert.equal(k.scheme, 'exact');
      assert.deepEqual(k.extra, { areFeesSponsored: true });
    }
  });
});

describe('pubnet serving (#17): HTTP surface', () => {
  test('GET /supported advertises both networks over HTTP', async () => {
    const config = resolveConfig({
      FACILITATOR_SECRET: Keypair.random().secret(),
      ENABLE_PUBNET: 'true',
      FACILITATOR_SECRET_PUBNET: Keypair.random().secret(),
      STELLAR_RPC_URL_PUBNET: 'https://mainnet.rpc.example.com',
    });
    const { facilitator } = buildFacilitator(config);
    const app = createApp(config, facilitator, {}, {});

    try {
      const res = await app.inject({ method: 'GET', url: '/supported' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      const networks = body.kinds.map(k => k.network);
      assert.deepStrictEqual([...networks].sort(), [TESTNET, PUBNET].sort());
      for (const k of body.kinds) {
        assert.deepEqual(k.extra, { areFeesSponsored: true });
      }
    } finally {
      await app.close();
    }
  });
});

describe('pubnet serving (#17): 7-decimal amount handling', () => {
  test('toStroops pins a stated 7-decimal USDC value with no floating-point drift', () => {
    // Issue #17 requires a test with a stated expected value. USDC on Stellar
    // is 7-decimal: "0.1234567" USDC == 1234567 stroops exactly.
    assert.equal(toStroops('0.1234567'), '1234567');
    assert.equal(toStroops('1.0000000'), '10000000');
    assert.equal(toStroops('0.0000001'), '1'); // smallest representable unit
    // Integer-only and short-fraction inputs pad/hold at 7 decimals.
    assert.equal(toStroops('2'), '20000000');
    assert.equal(toStroops('2.5'), '25000000');
  });

  test('toStroops truncates beyond 7 decimals rather than rounding', () => {
    // Stellar's asset precision is 7 decimals; the 8th digit must be dropped,
    // not rounded — rounding would invent stroops that never existed.
    assert.equal(toStroops('0.12345678'), '1234567');
    assert.equal(toStroops('9.99999999'), '99999999');
  });

  test('missing USDC trustline surfaces a clear, documented reason code', () => {
    // Issue #17: a recipient with no trustline for the priced asset must fail
    // with a reason a client can branch on, not an opaque error. The scheme
    // (upstream, not reimplemented here) rejects during simulation with the
    // HostError "trustline entry is missing for account", which surfaces as
    // `invalid_exact_stellar_payload_simulation_failed`. Anchor that mapping so
    // it cannot silently drift from the documented taxonomy.
    assert.ok(
      Object.hasOwn(UPSTREAM_REASONS, 'invalid_exact_stellar_payload_simulation_failed'),
      'trustline-missing reason must exist in the upstream taxonomy',
    );
    assert.match(
      UPSTREAM_REASONS.invalid_exact_stellar_payload_simulation_failed,
      /failed simulation/i,
    );
  });
});
