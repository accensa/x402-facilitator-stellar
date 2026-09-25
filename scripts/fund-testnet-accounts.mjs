#!/usr/bin/env node
/**
 * Generates and friendbot-funds the three testnet accounts the upstream x402 e2e
 * suite needs for the Stellar family, and prints them as env assignments.
 *
 * WHY GENERATE RATHER THAN STORE. The suite needs a client key, a server payee
 * address and a facilitator key. Holding those as long-lived repository secrets
 * means three funded keys sitting in CI configuration forever, rotated by
 * nobody, for a job that does not need them to persist for even one minute
 * longer than the run. Friendbot makes fresh accounts free, so the run creates
 * its own and throws them away.
 *
 * Three distinct accounts is not a stylistic choice: ExactStellarScheme rejects
 * any payment where the facilitator is a party to the transfer, so payer,
 * recipient and facilitator must be three different keys or verification fails
 * on the first request.
 *
 * Testnet only, by construction — friendbot does not exist on pubnet, and this
 * script has no pubnet path on purpose. Pubnet conformance needs real funded
 * accounts and is a deliberate, separate operational step.
 *
 * Usage:
 *   node scripts/fund-testnet-accounts.mjs              # prints env assignments
 *   node scripts/fund-testnet-accounts.mjs --json       # prints JSON
 *   node scripts/fund-testnet-accounts.mjs --github-env # appends to $GITHUB_ENV
 */
import { appendFileSync } from 'node:fs';
import { URLSearchParams } from 'node:url';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  Keypair,
  Asset,
  TransactionBuilder,
  Networks,
  Account,
  Operation,
} from '@stellar/stellar-sdk';
import { installRpcRetry } from '../src/rpc-retry.js';

// friendbot.stellar.org is behind Cloudflare and advertises AAAA records. On an
// IPv4-only host Node's built-in fetch times out against it while curl -4
// succeeds — the same dead-end src/rpc-retry.js exists to fix for Soroban RPC,
// and it bites here for exactly the same reason. Reuse it rather than writing a
// second IPv4 connector.
installRpcRetry({
  log: msg => console.error(`  ${msg}`),
  rpcForceIpv4: process.env.RPC_FORCE_IPV4 !== 'false',
});

const FRIENDBOT = process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org';
const ATTEMPTS = Number(process.env.FRIENDBOT_ATTEMPTS ?? 5);

/**
 * Funds one account, retrying transport failures.
 *
 * Friendbot is a free public service and is periodically rate limited or
 * briefly unavailable. A conformance run that fails because friendbot hiccuped
 * reports a facilitator problem that does not exist, so this retries rather
 * than letting a funding blip masquerade as a conformance failure.
 */
async function fund(publicKey, label) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`);
      if (res.ok) {
        console.error(`  funded ${label.padEnd(11)} ${publicKey}`);
        return;
      }
      // 400 with op_already_exists means someone funded it first, which is fine.
      const body = await res.text();
      if (res.status === 400 && body.includes('op_already_exists')) {
        console.error(`  exists ${label.padEnd(11)} ${publicKey}`);
        return;
      }
      lastError = new Error(`friendbot ${res.status}: ${body.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < ATTEMPTS) {
      const delay = 2000 * attempt;
      console.error(`  retry  ${label} in ${delay}ms — ${lastError.message.slice(0, 80)}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(
    `could not fund ${label} (${publicKey}) after ${ATTEMPTS} attempts: ${lastError?.message}`,
  );
}

/** Minimal base58 (Bitcoin alphabet) — the encoding Solana keys are given in. */
function base58Encode(bytes) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  // Leading zero bytes are significant and encode as '1'.
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/**
 * The two credentials the harness demands for families it is not running.
 *
 * `createE2EClient()` in e2e/clients/typescript/client.ts builds an EVM account
 * and an SVM signer unconditionally, before any family filter applies — every
 * other chain, Stellar included, is gated behind an `if (process.env.…)`. So
 * `--families=stellar` still dies at client startup with
 * "Cannot read properties of undefined (reading 'slice')" out of viem unless
 * CLIENT_EVM_PRIVATE_KEY and CLIENT_SVM_PRIVATE_KEY are set.
 *
 * These are generated, unfunded and never used: no scenario in a Stellar run
 * signs with them, and there is nothing on either chain to spend. They exist to
 * get past a constructor. Funding them, or reusing a real key, would be a
 * mistake — see docs/CONFORMANCE.md, where this is recorded as an upstream
 * finding rather than something we should be patching around silently.
 */
function unusedForeignFamilyKeys() {
  // secp256k1: any 32 non-zero bytes is a valid scalar with overwhelming
  // probability, and viem only needs it to be well-formed.
  const evm = `0x${randomBytes(32).toString('hex')}`;

  // @solana/kit's createKeyPairSignerFromBytes wants 64 bytes — a 32-byte seed
  // followed by its public key, and it checks that the two agree — so this has
  // to be a real ed25519 pair rather than 64 random bytes.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

  return { evm, svm: base58Encode(Buffer.concat([seed, pub])) };
}

const roles = ['client', 'server', 'facilitator'];
const keys = Object.fromEntries(roles.map(role => [role, Keypair.random()]));

console.error(`Funding three testnet accounts via ${FRIENDBOT}`);
// Sequential rather than parallel: friendbot rate limits, and three accounts is
// not worth the flakiness that concurrency buys here.
for (const role of roles) {
  await fund(keys[role].publicKey(), role);
}

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const usdcAsset = new Asset('USDC', USDC_ISSUER);

console.error('Establishing USDC trustlines...');
for (const role of roles) {
  const keypair = keys[role];
  const resAccount = await fetch(
    `https://horizon-testnet.stellar.org/accounts/${keypair.publicKey()}`,
  );
  if (!resAccount.ok) throw new Error(`Failed to load account: ${resAccount.status}`);
  const accountData = await resAccount.json();
  const account = new Account(keypair.publicKey(), accountData.sequence);
  const tx = new TransactionBuilder(account, { fee: '1000', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.changeTrust({
        asset: usdcAsset,
        limit: '1000000000',
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(keypair);

  const body = new URLSearchParams();
  body.append('tx', tx.toXDR());
  const res = await fetch('https://horizon-testnet.stellar.org/transactions', {
    method: 'POST',
    body,
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Failed to submit transaction: ${res.status} ${errorBody}`);
  }

  console.error(`  trusted USDC on ${role.padEnd(11)} ${keypair.publicKey()}`);
}

const foreign = unusedForeignFamilyKeys();

const env = {
  // The suite's own names, from e2e/config/mechanisms_stellar.json.
  CLIENT_STELLAR_PRIVATE_KEY: keys.client.secret(),
  SERVER_STELLAR_ADDRESS: keys.server.publicKey(),
  // Not an upstream variable, and deliberately not written into the harness's
  // .env: the payee's secret is needed only so scripts/prepare-testnet-usdc.mjs
  // can give it a USDC trustline, without which it cannot receive the payment.
  SERVER_STELLAR_PRIVATE_KEY: keys.server.secret(),
  FACILITATOR_STELLAR_PRIVATE_KEY: keys.facilitator.secret(),
  // What our own facilitator reads. Deliberately the same key as the one the
  // suite is told about, so the proxy and the service it fronts are one signer.
  FACILITATOR_SECRET: keys.facilitator.secret(),
  // Unfunded throwaways. See unusedForeignFamilyKeys() above.
  CLIENT_EVM_PRIVATE_KEY: foreign.evm,
  CLIENT_SVM_PRIVATE_KEY: foreign.svm,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(env, null, 2));
} else if (process.argv.includes('--github-env')) {
  const target = process.env.GITHUB_ENV;
  if (!target) {
    console.error('--github-env given but GITHUB_ENV is unset');
    process.exit(2);
  }
  appendFileSync(
    target,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
  console.error(`Wrote ${Object.keys(env).length} variables to $GITHUB_ENV`);
} else {
  for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
}
