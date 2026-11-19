/**
 * #688: the MCP session spend cap must be atomic and sign-aware.
 *
 * `assertCanSpend` compared only the upper bounds, so a negative BigInt was
 * approved (and then subtracted from the counter), and the counter was only
 * incremented after a paid request succeeded — so two tool calls in flight both
 * observed the same remaining budget and both were approved, spending past the
 * operator's limit. The cap is the agent wallet's money-safety control, so the
 * check and the commit have to be one synchronous step.
 *
 * Two layers are pinned here:
 *
 *   - the reservation helpers themselves — the synchronous step that no
 *     `await` can interleave with — driven in-process;
 *   - the real CLI over stdio against a stub resource server, proving a failed
 *     paid request releases its reservation and consumes no budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The caps are read at module load, so configure them before importing the CLI.
// No payer key: the in-process import must not try to start a wallet.
process.env.MAX_FEE_PER_CALL_STROOPS = '1000';
process.env.MAX_SESSION_SPEND_STROOPS = '100';
delete process.env.AGENT_PAYER_SECRET_KEY;

const { assertCanSpend, reserveSessionSpend, releaseSessionSpend, getSessionSpendStroops } =
  await import('../src/mcp/cli.js');

test('#688: non-positive amounts are refused and name the rule', async t => {
  await t.test('a negative amount is refused', () => {
    assert.throws(
      () => assertCanSpend(-1n),
      err => {
        assert.match(err.message, /^Spending refused:/, 'keeps the house refusal prefix');
        assert.match(err.message, /\(-1 stroops\)/, 'names the amount');
        assert.match(err.message, /not positive/, 'names the rule');
        return true;
      },
    );
    assert.equal(getSessionSpendStroops(), 0n, 'a refused amount never touches the counter');
  });

  await t.test('zero is refused', () => {
    assert.throws(
      () => assertCanSpend(0n),
      /\Spending refused: Request amount \(0 stroops\) is not positive/,
    );
    assert.equal(getSessionSpendStroops(), 0n);
  });

  await t.test('a negative reservation is refused too', () => {
    assert.throws(() => reserveSessionSpend(-500n), /not positive/);
    assert.equal(getSessionSpendStroops(), 0n);
  });
});

test('#688: two interleaved reservations cannot both fit', () => {
  // Each reservation fits alone against the 100-stroop cap; their sum does not.
  assert.equal(reserveSessionSpend(60n), 60n);
  assert.equal(getSessionSpendStroops(), 60n, 'the first reservation is committed immediately');

  assert.throws(
    () => reserveSessionSpend(60n),
    /exceeds remaining session budget \(spent 60\/100 stroops\)/,
    'the second reservation sees the first, because there is no await between check and commit',
  );

  assert.equal(getSessionSpendStroops(), 60n, 'the refused reservation changed nothing');

  releaseSessionSpend(60n);
  assert.equal(getSessionSpendStroops(), 0n, 'release restores the counter exactly');
});

test('#688: release never drives the counter below zero', () => {
  reserveSessionSpend(40n);
  releaseSessionSpend(40n);
  assert.equal(getSessionSpendStroops(), 0n);

  // A double release must not hand back budget that was never reserved.
  releaseSessionSpend(40n);
  assert.equal(getSessionSpendStroops(), 0n);
});

test('#688: the per-call cap still applies inside the reservation', () => {
  assert.throws(() => reserveSessionSpend(1001n), /exceeds per-call limit \(1000 stroops\)/);
  assert.equal(getSessionSpendStroops(), 0n);
});

// ---------------------------------------------------------------------------
// End to end: the real CLI, and a paid call that fails after the reservation.
//
// The exact Stellar scheme signs a real Soroban transaction against a live RPC,
// so a settled call cannot be produced offline. What can be driven is a 402 the
// v2-only client cannot pay: the amount parses and is reserved, then payload
// creation throws. That is the failure path the release must cover.
// ---------------------------------------------------------------------------

const AMOUNT = 60;
const SESSION_CAP = 100;

/** A v1 402 challenge: the amount parses, but this client has no v1 scheme. */
function paymentRequired() {
  return JSON.stringify({
    error: 'payment_required',
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'stellar:testnet',
        price: { asset: 'native', amount: String(AMOUNT) },
        payTo: 'GBQ...',
      },
    ],
  });
}

async function startStub() {
  const server = http.createServer((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(paymentRequired());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/unpayable`,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('#688: a failed paid call releases its reservation and consumes no budget', async t => {
  const { createMcpClient, getTestPayerKey } = await import('./helpers/mcp.js');
  const stub = await startStub();
  const client = createMcpClient({
    AGENT_PAYER_SECRET_KEY: getTestPayerKey(),
    MAX_FEE_PER_CALL_STROOPS: '1000',
    MAX_SESSION_SPEND_STROOPS: String(SESSION_CAP),
    NETWORK: 'stellar:testnet',
  });
  t.after(async () => {
    client.close();
    await stub.close();
  });

  const failsAfterReserving = /Failed to create payment payload/;

  // 60 stroops is reserved, then the call fails. Counter back to 0.
  await assert.rejects(
    client.callTool('call_paid_resource', { url: stub.url }),
    failsAfterReserving,
  );

  // If the first call had kept its reservation, 60 + 60 > 100 would make this
  // one fail with the session-budget refusal instead of the same error.
  await assert.rejects(
    client.callTool('call_paid_resource', { url: stub.url }),
    failsAfterReserving,
  );
  await assert.rejects(
    client.callTool('call_paid_resource', { url: stub.url }),
    failsAfterReserving,
  );
});
