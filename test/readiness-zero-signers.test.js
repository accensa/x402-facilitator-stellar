import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { createReadinessChecker } from '../src/readiness.js';

function fundedRpcStub(address, balance = 100_000_000) {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  const acct = new xdr.AccountEntry({
    accountId,
    balance: new xdr.Int64(balance),
    seqNum: new xdr.SequenceNumber(new xdr.Int64(0)),
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: '',
    thresholds: Buffer.alloc(4, 1),
    signers: [],
    ext: new xdr.AccountEntryExt(0),
  });
  const entryVal = xdr.LedgerEntryData.account(acct).toXDR('base64');

  return async (_url, body) => {
    if (body.method === 'getHealth') {
      return { result: { status: 'healthy' } };
    }
    if (body.method === 'getLedgerEntries') {
      return { result: { entries: [{ xdr: entryVal }] } };
    }
    throw new Error(`unexpected method ${body.method}`);
  };
}

describe('readiness checker with zero signer secrets (#776)', () => {
  test('fails signer_funded when network has no configured signer secrets', async () => {
    const config = {
      networks: ['stellar:testnet'],
      perNetwork: {
        'stellar:testnet': {
          rpcUrl: 'http://rpc.test',
          secrets: [],
        },
      },
      apiKeys: [],
    };

    const checker = createReadinessChecker(config, {
      rpcCall: async (_url, body) => {
        if (body.method === 'getHealth') return { result: { status: 'healthy' } };
        throw new Error(`unexpected method ${body.method}`);
      },
      cacheTtlMs: 0,
    });

    const report = await checker.check();
    assert.equal(report.ok, false);
    assert.equal(report.status, 'not_ready');
    const net = report.networks['stellar:testnet'];
    assert.equal(net.ready, false);
    assert.equal(net.checks.rpc_reachable.ok, true);
    assert.equal(net.checks.signer_funded.ok, false);
    assert.equal(net.checks.signer_funded.error, 'no signer accounts configured');
    assert.deepEqual(net.checks.signer_funded.signers, []);
  });

  test('fails signer_funded even when feeBumpSecret is set if primary signer secrets are empty', async () => {
    const feeBumpKp = Keypair.random();
    const config = {
      networks: ['stellar:testnet'],
      perNetwork: {
        'stellar:testnet': {
          rpcUrl: 'http://rpc.test',
          feeBumpSecret: feeBumpKp.secret(),
        },
      },
      apiKeys: [],
    };

    const checker = createReadinessChecker(config, {
      rpcCall: fundedRpcStub(feeBumpKp.publicKey()),
      cacheTtlMs: 0,
    });

    const report = await checker.check();
    assert.equal(report.ok, false);
    const net = report.networks['stellar:testnet'];
    assert.equal(net.ready, false);
    assert.equal(net.checks.signer_funded.ok, false);
    assert.equal(net.checks.signer_funded.error, 'no signer accounts configured');
  });

  test('succeeds when at least one funded signer secret is configured', async () => {
    const signerKp = Keypair.random();
    const config = {
      networks: ['stellar:testnet'],
      perNetwork: {
        'stellar:testnet': {
          rpcUrl: 'http://rpc.test',
          secret: signerKp.secret(),
        },
      },
      apiKeys: [],
    };

    const checker = createReadinessChecker(config, {
      rpcCall: fundedRpcStub(signerKp.publicKey()),
      cacheTtlMs: 0,
    });

    const report = await checker.check();
    assert.equal(report.ok, true);
    assert.equal(report.networks['stellar:testnet'].ready, true);
    assert.equal(report.networks['stellar:testnet'].checks.signer_funded.ok, true);
  });
});
