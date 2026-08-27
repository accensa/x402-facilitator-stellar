/**
 * End-to-end conformance run.
 *
 * The acceptance criterion this targets (RFP §3.6) is that an *unmodified*
 * canonical client completes a payment against the facilitator. So the client
 * here is `x402Client` + `x402HTTPClient` from @x402/core with the stock
 * `ExactStellarScheme` client — no local subclass, no patched transport, no
 * hand-rolled payload. If this passes, it passes because the wire format is
 * right, not because the test was shaped to fit.
 *
 * Topology, three distinct accounts because the scheme requires it:
 *
 *   alice (payer) ──pays──> deployer (merchant)
 *                    │
 *                    └── facilitator (submits + sponsors fee), must be neither
 *
 *   :3401  resource server  — @x402/express, points at our facilitator
 *   :3402  facilitator      — this repo, must already be running
 *
 * Usage:
 *   FACILITATOR_SECRET=$(stellar keys show facilitator) npm start &
 *   ALICE_SECRET=$(stellar keys show alice) node scripts/e2e.mjs
 */
import express from 'express';
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactStellarScheme as ExactStellarServer } from '@x402/stellar/exact/server';
import { ExactStellarScheme as ExactStellarClient } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';
import { installRpcRetry } from '../src/rpc-retry.js';

// The client makes its own RPC calls to build and simulate the payment. Install
// the wrapper at the fetch layer rather than around createPaymentPayload: the
// SDK wraps transport errors in an AxiosError that drops `cause.code`, so by the
// time the call returns, a connection timeout is indistinguishable from any
// other failure.
installRpcRetry({ log: msg => console.log(`    ${msg}`) });

const NETWORK = 'stellar:testnet';
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const MERCHANT =
  process.env.MERCHANT_ADDRESS ?? 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6';
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'http://localhost:3402';
const RESOURCE_PORT = Number(process.env.RESOURCE_PORT ?? 3401);

/** 1000 stroops = 0.0001 XLM. Small enough to run repeatedly on testnet. */
const PRICE_STROOPS = '1000';

const aliceSecret = process.env.ALICE_SECRET;
if (!aliceSecret) {
  console.error('ALICE_SECRET is required: ALICE_SECRET=$(stellar keys show alice)');
  process.exit(2);
}

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

/**
 * Retries a call that failed for transport reasons.
 *
 * This exists for local network flakiness, not to mask protocol failures. On
 * this machine Node's fetch intermittently times out against
 * soroban-testnet.stellar.org where curl to the same host succeeds every time —
 * both resolved IPs answer fine, so it is the Node HTTP stack and the local
 * link, not the RPC.
 *
 * Only connection-level failures are retried. A protocol error — a rejected
 * payment, a bad signature, a non-conformant response — is returned to the
 * caller on the first attempt, because retrying those would turn a conformance
 * failure into a flaky pass, which is the opposite of what this script is for.
 */
async function withTransportRetry(label, fn, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const cause = err?.cause?.code ?? err?.code;
      const transport =
        cause === 'ETIMEDOUT' ||
        cause === 'ECONNRESET' ||
        cause === 'ECONNREFUSED' ||
        cause === 'UND_ERR_CONNECT_TIMEOUT' ||
        cause === 'EAI_AGAIN';
      if (!transport || i === attempts) throw err;
      console.log(`    ${label}: ${cause}, retry ${i}/${attempts - 1}`);
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

// ---------------------------------------------------------------------------
// Resource server — an ordinary x402 seller that happens to point at us
// ---------------------------------------------------------------------------

const resourceServer = new x402ResourceServer([
  new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
]);
resourceServer.register(NETWORK, new ExactStellarServer());

let settlementSeen = null;
resourceServer.onAfterSettle(async ctx => {
  settlementSeen = ctx.result;
});

const httpServer = new x402HTTPResourceServer(resourceServer, {
  '/api/quote': {
    accepts: {
      scheme: 'exact',
      price: { asset: XLM_SAC, amount: PRICE_STROOPS },
      network: NETWORK,
      payTo: MERCHANT,
    },
  },
});

const app = express();
app.use(paymentMiddlewareFromHTTPServer(httpServer));
app.get('/api/quote', (_req, res) => {
  res.json({ symbol: 'XLM', price: '0.42', asOf: new Date().toISOString() });
});

const server = app.listen(RESOURCE_PORT);
await new Promise(r => server.once('listening', r));

// ---------------------------------------------------------------------------
// Canonical client — stock SDK, no modifications
// ---------------------------------------------------------------------------

const payer = createEd25519Signer(aliceSecret, NETWORK);
const client = new x402Client()
  .register(NETWORK, new ExactStellarClient(payer))
  // @x402/core >= 2.22 enforces client-side spend controls: by default only
  // "default" assets (USDC on Stellar) are payable. This script prices its own
  // route in XLM, so the XLM SAC must be opted in explicitly — with the control
  // left on rather than disabled, since this is a wire-conformance check, not a
  // spend-policy sandbox.
  .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: XLM_SAC }] });
const http = new x402HTTPClient(client);

const RESOURCE = `http://localhost:${RESOURCE_PORT}/api/quote`;
let exitCode = 0;

try {
  step(1, 'Facilitator /supported');
  const supported = await (await fetch(`${FACILITATOR_URL}/supported`)).json();
  const kind = supported.kinds?.find(k => k.network === NETWORK);
  if (!kind) throw new Error(`facilitator does not advertise ${NETWORK}`);
  console.log(`    scheme=${kind.scheme} x402Version=${kind.x402Version}`);
  console.log(`    extra=${JSON.stringify(kind.extra)}`);
  if (kind.extra?.areFeesSponsored !== true) {
    throw new Error('extra.areFeesSponsored missing or not true');
  }

  step(2, `Unpaid GET ${RESOURCE} — expecting 402`);
  const unpaid = await fetch(RESOURCE);
  console.log(`    status=${unpaid.status}`);
  if (unpaid.status !== 402) throw new Error(`expected 402, got ${unpaid.status}`);

  const body = await unpaid
    .clone()
    .json()
    .catch(() => undefined);
  const paymentRequired = http.getPaymentRequiredResponse(name => unpaid.headers.get(name), body);
  const req0 = paymentRequired.accepts?.[0];
  console.log(`    asset=${req0?.asset}`);
  console.log(`    amount=${req0?.maxAmountRequired ?? req0?.price?.amount}  payTo=${req0?.payTo}`);

  step(3, 'Client signs the auth entry (payer never sees a transaction)');
  const paymentPayload = await withTransportRetry('sign', () =>
    http.createPaymentPayload(paymentRequired),
  );
  console.log(`    payload keys: ${Object.keys(paymentPayload.payload ?? {}).join(', ')}`);

  step(4, 'Retry with X-PAYMENT — facilitator verifies, submits, sponsors the fee');
  const paid = await withTransportRetry('pay', () =>
    fetch(RESOURCE, { headers: http.encodePaymentSignatureHeader(paymentPayload) }),
  );
  console.log(`    status=${paid.status}`);
  const payload = await paid.text();

  const settle = http.getPaymentSettleResponse(name => paid.headers.get(name));

  if (paid.status !== 200) {
    console.log(`    body=${payload.slice(0, 400)}`);
    throw new Error(
      `payment did not complete: ${settle?.errorReason ?? 'unknown'} ` +
        `${settle?.errorMessage ?? ''}`.trim(),
    );
  }

  console.log(`    body=${payload}`);

  step(5, 'Settlement');
  const result = settle ?? settlementSeen;
  console.log(`    success=${result?.success}`);
  console.log(`    payer=${result?.payer}`);
  console.log(`    network=${result?.network}`);
  console.log(`    tx=${result?.transaction}`);

  if (!result?.success || !result?.transaction) {
    throw new Error('settlement reported no transaction hash');
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('PASS — unmodified canonical client completed a payment');
  console.log(`  tx     https://stellar.expert/explorer/testnet/tx/${result.transaction}`);
  console.log('────────────────────────────────────────────────────────────');
} catch (err) {
  exitCode = 1;
  console.error(`\nFAIL — ${err instanceof Error ? err.message : err}`);
  if (err?.cause) console.error(`  cause: ${err.cause?.message ?? err.cause}`);
  if (process.env.VERBOSE) console.error(err);
} finally {
  server.close();
  process.exit(exitCode);
}
