import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { resolveConfig } from '../src/config.js';
import { buildFacilitator, submitMultiSignerEnvelope } from '../src/facilitator.js';
import { createMultiSignerEngine } from '../src/multi-signer.js';
import { createApp } from '../src/app.js';
import { createReadinessChecker } from '../src/readiness.js';
import { signerMetrics } from '../src/metrics.js';

describe('Multi-Signer Pool & Fee-Bump Signer (#9)', () => {
  const k1 = Keypair.random();
  const k2 = Keypair.random();
  const k3 = Keypair.random();
  const fb = Keypair.random();

  test('resolveConfig parses multi-signer secrets and fee-bump secret', () => {
    const config = resolveConfig({
      FACILITATOR_SECRETS: `${k1.secret()},${k2.secret()}`,
      FEE_BUMP_SECRET: fb.secret(),
    });

    assert.equal(config.perNetwork['stellar:testnet'].secrets.length, 2);
    assert.equal(config.perNetwork['stellar:testnet'].secrets[0], k1.secret());
    assert.equal(config.perNetwork['stellar:testnet'].secrets[1], k2.secret());
    assert.equal(config.perNetwork['stellar:testnet'].feeBumpSecret, fb.secret());
  });

  test('threshold round-trip: 2-of-3 collects, assembles, and submits (#412)', async () => {
    const engine = createMultiSignerEngine({
      threshold: 2,
      requiredSigners: undefined,
    });
    engine.createEnvelope({
      id: 'env-1',
      transactionXdr: 'AAAA threshold tx',
      threshold: 2,
      requiredSigners: ['cosigner-a', 'cosigner-b', 'cosigner-c'],
    });
    assert.equal(engine.isComplete('env-1'), false);
    engine.addSignature('env-1', { signer: 'cosigner-a', signature: 'sig-a' });
    assert.equal(engine.isComplete('env-1'), false);
    // Duplicate signer does not double-count.
    engine.addSignature('env-1', { signer: 'cosigner-a', signature: 'sig-a2' });
    assert.equal(engine.getEnvelope('env-1').collected, 1);
    engine.addSignature('env-1', { signer: 'cosigner-b', signature: 'sig-b' });
    assert.equal(engine.isComplete('env-1'), true);

    const assembled = engine.assembleEnvelope('env-1');
    assert.equal(assembled.transactionXdr, 'AAAA threshold tx');
    assert.deepEqual(
      assembled.signatures.map(s => s.signer),
      ['cosigner-a', 'cosigner-b'],
    );

    const submitted = [];
    const result = await submitMultiSignerEnvelope(engine, 'env-1', async env => {
      submitted.push(env);
      return { hash: 'deadbeef' };
    });
    assert.equal(result.hash, 'deadbeef');
    assert.equal(submitted.length, 1);
  });

  test('partial signatures expire on deadline and never assemble (#412)', async () => {
    let t = 1_000;
    const engine = createMultiSignerEngine({ threshold: 2, now: () => t });
    engine.createEnvelope({
      id: 'env-expiry',
      transactionXdr: 'AAAA expiring',
      threshold: 2,
      requiredSigners: ['a', 'b'],
      expiresInMs: 50,
    });
    engine.addSignature('env-expiry', { signer: 'a', signature: 'sig-a' });
    t += 100;
    assert.equal(engine.purgeExpired(), 1);
    assert.throws(() => engine.assembleEnvelope('env-expiry'), /expired/);
    assert.throws(
      () => engine.addSignature('env-expiry', { signer: 'b', signature: 'sig-b' }),
      /expired/,
    );
    await assert.rejects(
      submitMultiSignerEnvelope(engine, 'env-expiry', async () => ({})),
      /expired/,
    );
  });

  test('co-signer endpoints are polled concurrently; one failure still reaches threshold (#412)', async () => {
    const fetchImpl = async url => {
      if (url.includes('bad')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      const signer = url.includes('one') ? 'cosigner-one' : 'cosigner-two';
      return { ok: true, json: async () => ({ signer, signature: `sig-${signer}` }) };
    };
    const engine = createMultiSignerEngine({
      threshold: 2,
      fetchImpl,
      requestTimeoutMs: 1000,
    });
    engine.createEnvelope({
      id: 'env-poll',
      transactionXdr: 'AAAA poll',
      threshold: 2,
      requiredSigners: ['cosigner-one', 'cosigner-two'],
    });
    const results = await engine.requestSignatures('env-poll', {
      endpoints: ['https://cosigner.one/sign', 'https://cosigner.two/sign', 'https://bad/sign'],
    });
    assert.equal(results.filter(r => r.ok).length, 2);
    assert.equal(results.filter(r => !r.ok).length, 1);
    assert.equal(engine.isComplete('env-poll'), true);
    const assembled = engine.assembleEnvelope('env-poll');
    assert.equal(assembled.signatures.length, 2);
  });

  test('unauthorized co-signer is refused and threshold above allow-list is rejected (#412)', () => {
    const engine = createMultiSignerEngine({ threshold: 1 });
    assert.throws(
      () =>
        engine.createEnvelope({
          id: 'bad-threshold',
          transactionXdr: 'AAAA',
          threshold: 3,
          requiredSigners: ['a', 'b'],
        }),
      /exceeds/,
    );
    engine.createEnvelope({
      id: 'env-auth',
      transactionXdr: 'AAAA',
      threshold: 1,
      requiredSigners: ['allowed'],
    });
    assert.throws(
      () => engine.addSignature('env-auth', { signer: 'intruder', signature: 'sig' }),
      /not an authorized co-signer/,
    );
  });

  test('resolveConfig falls back to FACILITATOR_SECRET for single signer', () => {
    const config = resolveConfig({
      FACILITATOR_SECRET: k1.secret(),
    });

    assert.equal(config.perNetwork['stellar:testnet'].secrets.length, 1);
    assert.equal(config.perNetwork['stellar:testnet'].secrets[0], k1.secret());
  });

  test('resolveConfig rejects duplicate secret keys in pool', () => {
    assert.throws(
      () =>
        resolveConfig({
          FACILITATOR_SECRETS: `${k1.secret()},${k1.secret()}`,
        }),
      /Duplicate secret key found/,
    );
  });

  test('resolveConfig rejects malformed secret keys', () => {
    assert.throws(
      () =>
        resolveConfig({
          FACILITATOR_SECRETS: 'invalidSecretKey',
        }),
      /must be a Stellar secret key/,
    );
  });

  test('buildFacilitator exports all pool signers and configures scheme', () => {
    const config = resolveConfig({
      FACILITATOR_SECRETS: `${k1.secret()},${k2.secret()},${k3.secret()}`,
      FEE_BUMP_SECRET: fb.secret(),
    });

    const { facilitator, signers, feeBumpSigners } = buildFacilitator(config);

    // buildFacilitator returns signers keyed by network
    assert.equal(signers['stellar:testnet'].length, 3);
    assert.equal(signers['stellar:testnet'][0], k1.publicKey());
    assert.equal(signers['stellar:testnet'][1], k2.publicKey());
    assert.equal(signers['stellar:testnet'][2], k3.publicKey());
    assert.equal(feeBumpSigners['stellar:testnet'], fb.publicKey());

    // The upstream x402Facilitator aggregates all signers under 'stellar:*'
    const supported = facilitator.getSupported();
    const poolSigners = supported.signers?.['stellar:*'] ?? [];
    assert.ok(poolSigners.length >= 3, `expected at least 3 signers, got ${poolSigners.length}`);
    assert.ok(poolSigners.includes(k1.publicKey()), 'k1 not in pool');
    assert.ok(poolSigners.includes(k2.publicKey()), 'k2 not in pool');
    assert.ok(poolSigners.includes(k3.publicKey()), 'k3 not in pool');
  });

  test('GET /supported reports all pool addresses over HTTP', async () => {
    const config = resolveConfig({
      FACILITATOR_SECRETS: `${k1.secret()},${k2.secret()}`,
    });
    const { facilitator } = buildFacilitator(config);
    const app = await createApp(config, facilitator, {}, {});

    try {
      const res = await app.inject({ method: 'GET', url: '/supported' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      // x402Facilitator.getSupported() returns signers keyed by 'stellar:*'
      const signerList = body.signers?.['stellar:*'] ?? body.signers?.['stellar:testnet'] ?? [];
      assert.equal(signerList.length, 2);
      assert.ok(signerList.includes(k1.publicKey()), `k1 (${k1.publicKey()}) not in signers`);
      assert.ok(signerList.includes(k2.publicKey()), `k2 (${k2.publicKey()}) not in signers`);
    } finally {
      await app.close();
    }
  });

  test('readiness checker checks all signers in pool', async () => {
    const config = resolveConfig({
      FACILITATOR_SECRETS: `${k1.secret()},${k2.secret()}`,
    });

    const checkedAddresses = [];
    const rpcStub = async (_url, body) => {
      if (body.method === 'getHealth') return { result: { status: 'healthy' } };
      if (body.method === 'getLedgerEntries') {
        // Build a minimal but valid serialized AccountEntry so readiness can parse the balance.
        const signerAddr = body.params.keys[0]; // base64 LedgerKey — we only need to respond
        checkedAddresses.push(signerAddr);
        const acct = new xdr.AccountEntry({
          accountId: k1.xdrPublicKey(),
          balance: new xdr.Int64(100_000_000),
          seqNum: new xdr.SequenceNumber(new xdr.Int64(0)),
          numSubEntries: 0,
          inflationDest: null,
          flags: 0,
          homeDomain: '',
          thresholds: Buffer.from([1, 0, 0, 0]),
          signers: [],
          ext: new xdr.AccountEntryExt(0),
        });
        const entry = xdr.LedgerEntryData.account(acct);
        return {
          result: {
            // Soroban RPC's getLedgerEntries returns the ledger data under
            // `xdr`, matching src/readiness.js — see test/readiness.test.js.
            entries: [{ xdr: entry.toXDR('base64') }],
          },
        };
      }
      return {};
    };

    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub,
      cacheTtlMs: 0,
    });

    const report = await checker.check();
    assert.equal(report.ok, true);
    assert.equal(checkedAddresses.length, 2);
  });

  test('GET /metrics returns Prometheus format signer metrics', async () => {
    signerMetrics.recordSelection('stellar:testnet', k1.publicKey());
    signerMetrics.incrementInflight('stellar:testnet', k1.publicKey());

    const config = resolveConfig({ FACILITATOR_SECRET: k1.secret() });
    const app = await createApp(config, { getSupported: () => ({}) }, {}, {});

    try {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      assert.equal(res.statusCode, 200);
      assert.match(res.payload, /x402_signer_selected_total/);
      assert.match(res.payload, /x402_signer_inflight/);
      assert.match(res.payload, new RegExp(k1.publicKey()));
    } finally {
      await app.close();
    }
  });
});
