#!/usr/bin/env node
/**
 * Puts the harness's payer and payee accounts in a state where the upstream
 * `/exact/stellar` route can actually be paid.
 *
 * WHY THIS IS NEEDED. The route is priced `$0.001`, and `@x402/stellar`
 * resolves a USD price to its default stablecoin — on testnet that is
 * `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, the Stellar Asset
 * Contract wrapping Circle's classic `USDC:GBBD47IF…`. Friendbot funds XLM and
 * nothing else, so a fresh account has no trustline to that asset and no
 * balance of it, and the payment dies in simulation:
 *
 *   HostError: Error(Contract, #13) … "trustline entry is missing for account"
 *
 * Two separate prerequisites follow, and they are not equally solvable:
 *
 *   1. TRUSTLINES on payer and payee. Free, and done here — a `changeTrust`
 *      from each account is all it takes.
 *   2. A USDC BALANCE on the payer. Nobody can mint Circle's testnet USDC on
 *      demand; it comes from Circle's faucet, which is a human with a browser.
 *      So this needs a pre-funded treasury account, supplied as
 *      TESTNET_USDC_TREASURY_SECRET, that dribbles out a cent per run — see
 *      PER_RUN_AMOUNT for why that figure is the real burn rate.
 *
 * ON THE TREASURY SECRET. Issue #14 asks for friendbot-funded fresh accounts
 * over stored keys, and everything that *can* be ephemeral still is: payer,
 * payee and facilitator are all generated per run. This one key cannot be,
 * because the asset cannot be minted. It is testnet-only by construction —
 * `Networks.TESTNET` is hardcoded below, there is no pubnet branch, and the
 * asset is a testnet issuer's — so the worst case if it leaks is that someone
 * takes a few testnet dollars that cost nothing to replace.
 *
 * When the secret is absent this exits 0 and reports `usdc_ready=false`. That
 * is deliberate: the payment path being unprovable for want of a faucet is a
 * configuration gap, not a conformance failure, and reporting it as a red
 * conformance run would be the kind of lie this job exists to prevent.
 *
 * Usage:
 *   node scripts/prepare-testnet-usdc.mjs --github-output
 */
import { appendFileSync } from 'node:fs';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { installRpcRetry } from '../src/rpc-retry.js';

// Same IPv4 dead-end as friendbot and Soroban RPC — see src/rpc-retry.js.
installRpcRetry({
  log: msg => console.error(`  ${msg}`),
  rpcForceIpv4: process.env.RPC_FORCE_IPV4 !== 'false',
});

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

// Circle's testnet USDC issuer. Asserted against the SAC address below rather
// than trusted: if upstream ever changes its default stablecoin, this run must
// stop with a clear message instead of quietly preparing the wrong asset.
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const EXPECTED_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

// One run spends $0.001 on the `/exact/stellar` route. This is 10x that, which
// leaves room for a scenario that pays more than once without being so much
// that the treasury drains on a schedule.
//
// The payer is a fresh keypair every run and is never swept, so whatever is sent
// here is stranded once the run ends — this figure is the true per-run burn, not
// a float. At 0.01 a single faucet pull of 20 USDC funds ~2,000 runs, which is
// over five years of the daily cron. At the previous 1.0 it was 20 runs, or
// under three weeks, and topping up needs a human at Circle's faucet.
const PER_RUN_AMOUNT = '0.0100000';
const TRUSTLINE_LIMIT = '1000000';

const usdc = new Asset('USDC', USDC_ISSUER);
if (usdc.contractId(Networks.TESTNET) !== EXPECTED_SAC) {
  console.error(
    `::error::USDC SAC mismatch — expected ${EXPECTED_SAC}, derived ${usdc.contractId(Networks.TESTNET)}. ` +
      "Upstream's default Stellar stablecoin has changed; this script needs updating.",
  );
  process.exit(1);
}

const server = new Horizon.Server(HORIZON);

/** Submits ops signed by `keypair`, tolerating a trustline that already exists. */
async function submit(keypair, ops, label) {
  const account = await server.loadAccount(keypair.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) builder.addOperation(op);

  const tx = builder.setTimeout(60).build();
  tx.sign(keypair);

  try {
    const res = await server.submitTransaction(tx);
    console.error(`  ${label}: ${res.hash}`);
    return res.hash;
  } catch (err) {
    const codes = err?.response?.data?.extras?.result_codes;
    // Re-running against an already-prepared account is not an error.
    if (JSON.stringify(codes ?? {}).includes('op_already_exists')) {
      console.error(`  ${label}: already in place`);
      return null;
    }
    console.error(`  ${label} failed: ${JSON.stringify(codes ?? err.message)}`);
    throw err;
  }
}

const clientSecret = process.env.CLIENT_STELLAR_PRIVATE_KEY;
const serverAddress = process.env.SERVER_STELLAR_ADDRESS;
if (!clientSecret || !serverAddress) {
  console.error('::error::CLIENT_STELLAR_PRIVATE_KEY and SERVER_STELLAR_ADDRESS must be set');
  process.exit(2);
}

const outputs = {};
const finish = (ready, reason) => {
  outputs.usdc_ready = String(ready);
  outputs.usdc_reason = reason;
  if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
    );
  }
  console.error(ready ? `USDC ready: ${reason}` : `USDC not ready: ${reason}`);
  process.exit(0);
};

const treasurySecret = process.env.TESTNET_USDC_TREASURY_SECRET;
if (!treasurySecret) {
  finish(
    false,
    'TESTNET_USDC_TREASURY_SECRET is not configured, so the payer cannot hold the ' +
      'USDC the $0.001 route is priced in. Trustlines were not created either — ' +
      'they are useless without a balance.',
  );
}

const client = Keypair.fromSecret(clientSecret);
const treasury = Keypair.fromSecret(treasurySecret);

console.error(`Preparing USDC on ${HORIZON}`);
console.error(`  asset    USDC:${USDC_ISSUER}`);
console.error(`  treasury ${treasury.publicKey()}`);

// The payee needs a trustline too — a transfer into an account with none fails
// the same way the payer's does. Its secret is in CLIENT-shaped env only for
// the payer, so the payee trustline is created by the payee keypair, which the
// funding script emits alongside SERVER_STELLAR_ADDRESS.
const serverSecret = process.env.SERVER_STELLAR_PRIVATE_KEY;
if (!serverSecret || Keypair.fromSecret(serverSecret).publicKey() !== serverAddress) {
  finish(
    false,
    'SERVER_STELLAR_PRIVATE_KEY is missing or does not match SERVER_STELLAR_ADDRESS, ' +
      'so the payee cannot be given a USDC trustline and any transfer to it would fail.',
  );
}

try {
  const changeTrust = Operation.changeTrust({ asset: usdc, limit: TRUSTLINE_LIMIT });

  await submit(client, [changeTrust], 'payer trustline');
  await submit(Keypair.fromSecret(serverSecret), [changeTrust], 'payee trustline');

  await submit(
    treasury,
    [Operation.payment({ destination: client.publicKey(), asset: usdc, amount: PER_RUN_AMOUNT })],
    `payer funded with ${PER_RUN_AMOUNT} USDC`,
  );
} catch (err) {
  // A treasury that has run dry, or Horizon being unavailable, is again a
  // prerequisite problem rather than a conformance result.
  finish(false, `preparation failed: ${err.message?.slice(0, 200) ?? err}`);
}

finish(true, `payer holds ${PER_RUN_AMOUNT} USDC and both accounts carry trustlines`);
