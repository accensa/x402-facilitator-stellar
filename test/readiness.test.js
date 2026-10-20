/**
 * GET /readyz and the readiness checker (issue #100).
 *
 * The distinction under test: /healthz is liveness — cheap, dependency-free,
 * always 200 while the process runs. /readyz is readiness — it CAN fail,
 * names which check failed for which network, is cached, bounds its own RPC
 * timeouts instead of inheriting the ~12s retry budget, and reports catalogue
 * trouble without ever failing on it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { createReadinessChecker } from '../src/readiness.js';
import { serve } from './helpers/app.js';

// A fresh random signer per run — nothing asserts a specific address.
function signerSecret() {
  return Keypair.random().secret();
}

const SECRET_A = signerSecret();

function configWith(networks) {
  const perNetwork = {};
  for (const [network, rpcUrl] of networks) {
    perNetwork[network] = { secret: SECRET_A, rpcUrl };
  }
  return {
    networks: networks.map(([n]) => n),
    perNetwork,
    apiKeys: [],
  };
}

/** Builds an rpcCall stub whose getHealth/getLedgerEntries behaviour is scripted. */
function rpcStub({
  healthy = true,
  balance = 100_000_000,
  accountMissing = false,
  failDial = false,
} = {}) {
  const calls = [];
  const address = Keypair.fromSecret(SECRET_A).publicKey();
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  let entryVal = null;
  if (!accountMissing) {
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
    entryVal = xdr.LedgerEntryData.account(acct).toXDR('base64');
  }
  const stub = async (url, body) => {
    calls.push(body.method);
    if (failDial) {
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    }
    if (body.method === 'getHealth') {
      return { result: { status: healthy ? 'healthy' : 'degraded' } };
    }
    if (body.method === 'getLedgerEntries') {
      // Soroban RPC returns the entry's ledger data under `xdr` (shape:
      // key/xdr/lastModifiedLedgerSeq/extXdr). The stub must mirror the real
      // wire shape or the checker can pass tests while failing in production.
      return { result: { entries: entryVal ? [{ xdr: entryVal }] : [] } };
    }
    throw new Error(`unexpected method ${body.method}`);
  };
  stub.calls = calls;
  return stub;
}

describe('readiness checker', () => {
  test('healthy rpc and a funded signer are ready', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const checker = createReadinessChecker(config, { rpcCall: rpcStub(), cacheTtlMs: 0 });
    const report = await checker.check();
    assert.equal(report.ok, true);
    assert.equal(report.status, 'ready');
    assert.equal(report.networks['stellar:testnet'].ready, true);
    assert.equal(report.networks['stellar:testnet'].checks.rpc_reachable.ok, true);
    assert.equal(report.networks['stellar:testnet'].checks.signer_funded.ok, true);
  });

  test('unreachable rpc fails with the check named for the network', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub({ failDial: true }),
      cacheTtlMs: 0,
    });
    const report = await checker.check();
    assert.equal(report.ok, false);
    const net = report.networks['stellar:testnet'];
    assert.equal(net.ready, false);
    assert.equal(net.checks.rpc_reachable.ok, false);
    assert.match(net.checks.rpc_reachable.error, /ECONNREFUSED/);
    // The failing check and the network are both named — an operator reads the
    // body without correlating logs.
    assert.equal(net.checks.signer_funded.ok, false, 'signer check cannot succeed either');
  });

  test('a missing or below-floor signer account fails readiness by name', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);

    const missing = createReadinessChecker(config, {
      rpcCall: rpcStub({ accountMissing: true }),
      cacheTtlMs: 0,
    });
    const missingReport = await missing.check();
    assert.equal(missingReport.networks['stellar:testnet'].checks.rpc_reachable.ok, true);
    assert.equal(missingReport.networks['stellar:testnet'].checks.signer_funded.ok, false);
    assert.match(
      missingReport.networks['stellar:testnet'].checks.signer_funded.error,
      /does not exist/,
    );

    const poor = createReadinessChecker(config, {
      rpcCall: rpcStub({ balance: 500 }),
      cacheTtlMs: 0,
      minBalanceStroops: 1_000_000,
    });
    const poorReport = await poor.check();
    const signer = poorReport.networks['stellar:testnet'].checks.signer_funded;
    assert.equal(signer.ok, false);
    // Multi-signer: individual signer results are in signer.signers[]
    assert.equal(signer.signers[0].balance_stroops, 500);
    assert.match(signer.error, /below floor 1000000/);
  });

  test('per-network status, not one aggregate boolean', async () => {
    const config = configWith([
      ['stellar:testnet', 'http://good.rpc'],
      ['stellar:pubnet', 'http://bad.rpc'],
    ]);
    const good = rpcStub();
    const bad = rpcStub({ failDial: true });
    const checker = createReadinessChecker(config, {
      rpcCall: (url, body) => (url === 'http://good.rpc' ? good(url, body) : bad(url, body)),
      cacheTtlMs: 0,
    });
    const report = await checker.check();
    assert.equal(report.ok, false, 'one broken network makes the instance not ready');
    assert.equal(report.networks['stellar:testnet'].ready, true);
    assert.equal(report.networks['stellar:pubnet'].ready, false);
  });

  test('results are cached for the ttl; invalidation forces a re-dial', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const stub = rpcStub();
    const checker = createReadinessChecker(config, { rpcCall: stub, cacheTtlMs: 60_000 });

    await checker.check();
    await checker.check();
    assert.deepEqual(stub.calls.length, 2, 'second call inside ttl served from cache');

    checker.invalidate();
    await checker.check();
    assert.ok(stub.calls.length > 2, 'invalidated check dials again');
  });

  test('catalogue trouble is reported but never fails readiness', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const catalog = {
      healthCheck: async () => {
        throw new Error('index corrupted');
      },
    };
    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub(),
      cacheTtlMs: 0,
      catalog,
    });
    const report = await checker.check();
    assert.equal(report.ok, true, 'catalogue failure must not fail readiness');
    assert.equal(report.catalog.ok, false);
    assert.match(report.catalog.error, /corrupted/);
  });

  test('setShuttingDown flips check to ok: false and status: shutting_down', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub(),
      cacheTtlMs: 0,
    });
    let report = await checker.check();
    assert.equal(report.ok, true);
    checker.setShuttingDown();
    report = await checker.check();
    assert.equal(report.ok, false);
    assert.equal(report.status, 'shutting_down');
  });

  test('database check failure fails readiness and names the component', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub(),
      cacheTtlMs: 0,
      db: async () => ({ ok: false, error: 'connection refused' }),
    });
    const report = await checker.check();
    assert.equal(report.ok, false);
    assert.equal(report.database.ok, false);
    assert.equal(report.database.component, 'database');
    assert.match(report.database.error, /connection refused/);
  });

  test('redis check failure fails readiness and names the component', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub(),
      cacheTtlMs: 0,
      redis: async () => ({ ok: false, error: 'ECONNREFUSED' }),
    });
    const report = await checker.check();
    assert.equal(report.ok, false);
    assert.equal(report.redis.ok, false);
    assert.equal(report.redis.component, 'redis');
    assert.match(report.redis.error, /ECONNREFUSED/);
  });

  test('rate limiter backend check failure fails readiness and names the component', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub(),
      cacheTtlMs: 0,
      rateLimiterBackend: async () => ({ ok: false, error: 'table missing' }),
    });
    const report = await checker.check();
    assert.equal(report.ok, false);
    assert.equal(report.rate_limiter_backend.ok, false);
    assert.equal(report.rate_limiter_backend.component, 'rate_limiter_backend');
    assert.match(report.rate_limiter_backend.error, /table missing/);
  });

  test('all infrastructure checks pass when healthy', async () => {
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub(),
      cacheTtlMs: 0,
      db: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
      rateLimiterBackend: async () => ({ ok: true }),
    });
    const report = await checker.check();
    assert.equal(report.ok, true);
    assert.equal(report.database.ok, true);
    assert.equal(report.redis.ok, true);
    assert.equal(report.rate_limiter_backend.ok, true);
  });

  test('infrastructure checks are cached with the same TTL', async () => {
    let dbCalls = 0;
    const config = configWith([['stellar:testnet', 'http://rpc.test']]);
    const checker = createReadinessChecker(config, {
      rpcCall: rpcStub(),
      cacheTtlMs: 60_000,
      db: async () => {
        dbCalls++;
        return { ok: true };
      },
    });
    await checker.check();
    await checker.check();
    assert.equal(dbCalls, 1, 'db check should be cached');
    checker.invalidate();
    await checker.check();
    assert.equal(dbCalls, 2, 'db check should run again after invalidation');
  });
});

describe('GET /readyz over HTTP', () => {
  test('503 with a body naming the failing dependency and network', async () => {
    const app = await serve({
      extras: {
        readiness: {
          check: async () => ({
            ok: false,
            status: 'not_ready',
            checked_at: new Date().toISOString(),
            networks: {
              'stellar:testnet': {
                ready: false,
                checks: { rpc_reachable: { ok: false, error: 'connect ECONNREFUSED' } },
              },
            },
            breakers: {},
          }),
        },
      },
    });
    try {
      const res = await app.get('/readyz');
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(
        JSON.stringify(body.networks['stellar:testnet'].checks.rpc_reachable.error),
        /ECONNREFUSED/,
      );
    } finally {
      await app.close();
    }
  });

  test('200 when every network is ready', async () => {
    const app = await serve({
      extras: {
        readiness: {
          check: async () => ({ ok: true, status: 'ready', networks: {}, breakers: {} }),
        },
      },
    });
    try {
      const res = await app.get('/readyz');
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, 'ready');
    } finally {
      await app.close();
    }
  });
});
