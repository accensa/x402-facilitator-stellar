/**
 * End-to-end conformance run for __check_auth smart-account payers (#13).
 *
 * The classic-keypair proof lives in e2e.mjs: an unmodified canonical client
 * completes a payment whose payer is an ed25519 keypair. This script is the
 * second payer shape — a custom Soroban **account contract** implementing
 * `__check_auth` — which is the shape agent wallets take when they carry a
 * spending policy, and the case most likely to regress silently because
 * `ExactStellarScheme.verify` treats credential types differently.
 *
 * It is a separate script (rather than an extension of e2e.mjs) because the
 * setup is a different harness — deploy a contract, fund the contract
 * account, exercise a spend cap — and because keeping the classic proof in
 * its own file means a change here can never risk the canonical one.
 *
 * Topology, three distinct parties because the scheme requires it:
 *
 *   smart account (payer, a deployed contract) ──pays──> merchant
 *                    │
 *                    └── facilitator (submits + sponsors fee), must be neither
 *
 *   :RESOURCE_PORT  resource server  — @x402/express, points at our facilitator
 *   :FACILITATOR    facilitator      — this repo; spawned as a child unless
 *                                      FACILITATOR_URL points at a running one
 *
 * The payer is a deployed instance of test/fixtures/smart_account.wasm (see
 * test/fixtures/smart-account/README.md for build/deploy steps). The client
 * is the stock x402 client + ExactStellarScheme with a SEP-43 signer whose
 * `address` is the contract address — no patched transport, no hand-rolled
 * payload. One documented deviation exists (see `createContractAccountSigner`
 * below and docs/CONFORMANCE.md): signing an auth entry for a C-address must
 * return the signature as an ScVal, because the SDK's classic-keypair
 * verifier cannot decode a contract address.
 *
 * Scenarios:
 *   A  plain (cap disabled)            — payment settles end to end
 *   B  spend cap >= price              — payment settles (inside the cap)
 *   C  spend cap <  price              — payment rejected: the stock client
 *                                        cannot even produce the authorization
 *                                        (its own simulation runs __check_auth),
 *                                        and the signed authorization sent to
 *                                        /verify is rejected with a non-null
 *                                        invalidReason
 *   D  auth-entry comparison           — XDR description of a classic-keypair
 *                                        auth entry vs a contract-account one
 *
 * Usage (facilitator spawned for you):
 *   node scripts/e2e-smart-account.mjs
 *
 * Or against an already-running facilitator:
 *   FACILITATOR_URL=http://localhost:3402 node scripts/e2e-smart-account.mjs
 *
 * Exit 0 on success, 1 on any conformance failure, 2 on usage error.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import express from 'express';
import {
  Keypair,
  StrKey,
  Address,
  nativeToScVal,
  xdr,
  hash,
  Transaction,
  Operation,
  authorizeEntry,
  contract,
  rpc,
} from '@stellar/stellar-sdk';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactStellarScheme as ExactStellarServer } from '@x402/stellar/exact/server';
import { ExactStellarScheme as ExactStellarClient } from '@x402/stellar/exact/client';
import {
  createEd25519Signer,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  getEstimatedLedgerCloseTimeSeconds,
} from '@x402/stellar';
import { installRpcRetry } from '../src/rpc-retry.js';

// The client makes its own RPC calls to build and simulate the payment. Install
// the wrapper at the fetch layer (see scripts/e2e.mjs for why).
installRpcRetry({ log: msg => console.log(`    ${msg}`) });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const NETWORK = 'stellar:testnet';
const NETWORK_PASSPHRASE = getNetworkPassphrase(NETWORK);
const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const FRIENDBOT_URL = process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org';
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
let FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:3402';
const WASM_PATH =
  process.env.SMART_ACCOUNT_WASM ?? join(ROOT, 'test', 'fixtures', 'smart_account.wasm');

/** 1000 stroops = 0.0001 XLM. Small enough to run repeatedly on testnet. */
const PRICE_STROOPS = 1000;
/** Cap below the price: any authorization over it must be rejected. */
const OVER_CAP_STROOPS = 500;
/** Cap comfortably above the price: an in-cap payment must settle. */
const IN_CAP_STROOPS = 1_000_000;
/** XLM each contract account is funded with (10 XLM = 100,000,000 stroops). */
const CONTRACT_FUNDING_STROOPS = 100_000_000;

// Fresh accounts per run (same convention as scripts/fund-testnet-accounts.mjs):
// friendbot funds the classic ones, the contract accounts get their balance
// from the deployer, and the merchant only ever receives.
const deployerKeypair = Keypair.random();
const ownerKeypair = Keypair.random();
const merchantKeypair = Keypair.random();
const facilitatorKeypair = Keypair.random();
const MERCHANT_ADDRESS = merchantKeypair.publicKey();

const shouldSpawnFacilitator = !process.env.FACILITATOR_URL;
const RESOURCE_PORT = await freePort();

let exitCode = 0;
const children = new Set();
let resourceServer = null;

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

async function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(143)));

/** A free localhost TCP port, so the servers never collide with anything. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Retries a call that failed for transport reasons (same rationale and
 * limitations as scripts/e2e.mjs: connection-level failures only, never
 * protocol failures).
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

async function fundWithFriendbot(publicKey) {
  const res = await withTransportRetry('friendbot', () =>
    fetch(`${FRIENDBOT_URL}?addr=${publicKey}`),
  );
  if (!res.ok) {
    throw new Error(
      `friendbot refused to fund ${publicKey}: HTTP ${res.status} ${await res.text()}`,
    );
  }
  const body = await res.json();
  const account = body?._embedded?.records?.[0]?.account;
  if (account && account !== publicKey) {
    throw new Error(`friendbot funded ${account}, expected ${publicKey}`);
  }
  console.log(`    funded ${publicKey} (${body?.hash ?? 'ok'})`);
}

/** Polls `url` until `predicate(response)` is true or the timeout elapses. */
async function waitFor(url, { timeoutMs = 60_000, intervalMs = 250, predicate }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'never responded';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      last = `HTTP ${res.status}`;
      if (predicate(res)) return res;
    } catch (err) {
      last = `fetch error: ${err.cause?.code ?? err.message}`;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${url} (last: ${last})`);
}

// ---------------------------------------------------------------------------
// Contract deployment — stock @stellar/stellar-sdk code, no soroban CLI
// ---------------------------------------------------------------------------

// Contract IDs are the hash of the HashIdPreimage XDR (which folds in the
// network id), so the live deployed address is taken from the create
// simulation result — see createSmartAccountInstance — never derived by
// hand; a wrong derivation silently yields an address that does not exist.

/**
 * Uploads the wasm once and returns its 32-byte hash. Uploading an already
 * present wasm is a read call (the hash is returned with no footprint), so
 * re-uploading per instance would trip the SDK's isReadCall guard.
 */
async function uploadSmartAccountWasm(deployerKeypair) {
  const wasm = readFileSync(WASM_PATH);
  console.log(`    uploading ${WASM_PATH} (${wasm.length} bytes)`);
  const { signTransaction } = basicNodeSigner(deployerKeypair, NETWORK_PASSPHRASE);
  const upload = await withTransportRetry('upload wasm', () =>
    contract.AssembledTransaction.buildWithOp(Operation.uploadContractWasm({ wasm }), {
      publicKey: deployerKeypair.publicKey(),
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      signTransaction,
    }),
  );
  // Wasm uploads are keyed by hash globally: if this exact binary was already
  // uploaded (a previous run), the upload is a read call that needs no
  // signature — the simulation still returns the existing hash.
  try {
    await upload.signAndSend();
  } catch (err) {
    if (!/read call/i.test(err.message)) throw err;
  }
  const wasmHash = upload.simulationData.result.retval.bytes();
  if (!wasmHash || wasmHash.length !== 32) {
    throw new Error(
      `upload did not return a 32-byte wasm hash (got ${wasmHash?.length ?? 'none'})`,
    );
  }
  return wasmHash;
}

/**
 * Creates a contract instance with constructor args (owner, spend_cap) and
 * returns the deployed contract address.
 */
async function createSmartAccountInstance({ deployerKeypair, wasmHash, ownerPublicKey, spendCap }) {
  const { signTransaction } = basicNodeSigner(deployerKeypair, NETWORK_PASSPHRASE);
  const options = {
    publicKey: deployerKeypair.publicKey(),
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    signTransaction,
  };

  const salt = randomBytes(32);
  console.log(`    creating contract instance (salt …${salt.subarray(28).toString('hex')})`);
  const create = await withTransportRetry('create contract', () =>
    contract.AssembledTransaction.buildWithOp(
      Operation.createCustomContract({
        wasmHash,
        salt,
        address: Address.fromString(deployerKeypair.publicKey()),
        constructorArgs: [
          nativeToScVal(StrKey.decodeEd25519PublicKey(ownerPublicKey), { type: 'bytes' }),
          nativeToScVal(spendCap, { type: 'i128' }),
        ],
      }),
      options,
    ),
  );
  // The authoritative address is the simulation result — the created
  // contract's ScAddress — NOT a locally derived sha256 of the preimage
  // (contract IDs also fold in the network id; getting that wrong silently
  // produces an address for a contract that does not exist).
  const created = create.simulationData.result.retval;
  if (!created || created.switch().name !== 'scvAddress') {
    throw new Error(`create simulation did not return the new contract address`);
  }
  const contractAddress = Address.fromScAddress(created.address()).toString();
  await create.signAndSend();

  console.log(`    deployed ${contractAddress} (spend_cap=${spendCap})`);
  return contractAddress;
}

/**
 * Funds a contract account's token balance. A contract address cannot be a
 * classic payment destination — its XLM lives in the SAC, keyed by the
 * contract address — so funding is a SAC `transfer` from the deployer, with
 * the deployer's classic ed25519 auth (friendbot cannot fund C-addresses).
 */
async function fundContractAddress({ fromKeypair, contractAddress, amountStroops }) {
  const { signTransaction } = basicNodeSigner(fromKeypair, NETWORK_PASSPHRASE);
  const tx = await withTransportRetry('fund contract', () =>
    contract.AssembledTransaction.build({
      contractId: XLM_SAC,
      method: 'transfer',
      args: [
        nativeToScVal(fromKeypair.publicKey(), { type: 'address' }),
        nativeToScVal(contractAddress, { type: 'address' }),
        nativeToScVal(String(amountStroops), { type: 'i128' }),
      ],
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: fromKeypair.publicKey(),
      signTransaction,
      parseResultXdr: result => result,
    }),
  );
  await tx.signAndSend();
  console.log(`    funded ${contractAddress} with ${amountStroops} stroops`);
}

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

/**
 * A SEP-43 client signer for a smart-account payer.
 *
 * `address` is the deployed contract address; `signAuthEntry` signs the
 * authorization payload with the owner key. The contract's `__check_auth`
 * verifies that signature during simulation.
 *
 * GLUE FINDING (reported in docs/CONFORMANCE.md): the SDK's `authorizeEntry`
 * verifies the produced signature with `Keypair.fromPublicKey(payerAddress)`,
 * which cannot decode a C-address. The SDK's documented extension point for
 * that case is returning `{ signatureScVal, address }` from the signer, which
 * skips the keypair check. Everything here is stock SDK primitives — this is
 * the SEP-43 signer interface doing its job, not a patched transport.
 */
function createContractAccountSigner({ contractAddress, ownerKeypair }) {
  return {
    address: contractAddress,
    // Accepts either the HashIdPreimage object the SDK's authorizeEntry passes
    // (see signAuthEntriesForContractPayer below) or its base64 XDR.
    async signAuthEntry(arg) {
      const preimage = typeof arg === 'string' ? xdr.HashIdPreimage.fromXDR(arg, 'base64') : arg;
      const payload = hash(preimage.toXDR());
      const signature = ownerKeypair.sign(payload);
      const sigScVal = nativeToScVal(
        {
          public_key: StrKey.decodeEd25519PublicKey(ownerKeypair.publicKey()),
          signature,
        },
        { type: { public_key: ['symbol', null], signature: ['symbol', null] } },
      );
      return {
        signatureScVal: xdr.ScVal.scvVec([sigScVal]),
        address: contractAddress,
      };
    },
  };
}

/**
 * Signs every unsigned auth entry belonging to the payer via the SDK's own
 * `authorizeEntry`.
 *
 * This is the whole deviation from upstream, and it exists because upstream
 * cannot express it: `ExactStellarScheme.createPaymentPayload` signs through
 * `AssembledTransaction.signAuthEntries`, whose wrapper converts the signer's
 * result with `Buffer.from(...)` and then makes the SDK verify the signature
 * against `Keypair.fromPublicKey(payerAddress)` — an ed25519 decoder that
 * cannot decode a C-address. The SDK's documented extension point for signers
 * that do not own an ed25519 keypair is `authorizeEntry`'s `signatureScVal`
 * return (see @stellar/stellar-sdk base/auth.js), which skips the keypair
 * check. Everything below is stock SDK machinery; only the wiring differs.
 */
async function signAuthEntriesForContractPayer(tx, payer, expiration, networkPassphrase) {
  const entries = tx.built.operations[0].auth ?? [];
  let signedCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const credentials = entries[i].credentials();
    if (credentials.switch().name !== 'sorobanCredentialsAddress') continue;
    const entryAddress = Address.fromScAddress(credentials.address().address()).toString();
    if (entryAddress !== payer.address) continue;
    entries[i] = await authorizeEntry(
      entries[i],
      payer.signAuthEntry,
      expiration,
      networkPassphrase,
    );
    signedCount += 1;
  }
  if (signedCount === 0) {
    throw new Error(`no unsigned auth entry found for payer ${payer.address}`);
  }
}

/**
 * The x402 Exact-stellar client scheme for a smart-account payer.
 *
 * Subclasses the stock @x402/stellar ExactStellarScheme client and mirrors its
 * `createPaymentPayload` (Apache-2.0, ~45 lines) with one substitution: the
 * auth entries are signed via `signAuthEntriesForContractPayer` instead of
 * `tx.signAuthEntries`, which cannot sign for a C-address (see above). The
 * x402 client, the 402/retry/settle wire flow, the resource server and the
 * facilitator are untouched — this is the documented deviation #13 requires
 * to be reported rather than silently patched around.
 */
class ContractAccountExactScheme extends ExactStellarClient {
  async createPaymentPayload(x402Version, paymentRequirements) {
    try {
      this.validateCreateAndSignPaymentInput(paymentRequirements);
    } catch (error) {
      throw new Error(`Invalid input parameters for creating Stellar payment, cause: ${error}`);
    }
    const sourcePublicKey = this.signer.address;
    const { network, payTo, asset, amount, extra, maxTimeoutSeconds } = paymentRequirements;
    const networkPassphrase = getNetworkPassphrase(network);
    if (!extra.areFeesSponsored) {
      throw new Error(`Exact scheme requires areFeesSponsored to be true`);
    }
    const rpcServer = getRpcClient(network, this.rpcConfig);
    const latestLedger = await rpcServer.getLatestLedger();
    const currentLedger = latestLedger.sequence;
    const estimatedLedgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
    const maxLedger = currentLedger + Math.ceil(maxTimeoutSeconds / estimatedLedgerSeconds);
    const tx = await contract.AssembledTransaction.build({
      contractId: asset,
      method: 'transfer',
      args: [
        nativeToScVal(sourcePublicKey, { type: 'address' }),
        nativeToScVal(payTo, { type: 'address' }),
        nativeToScVal(amount, { type: 'i128' }),
      ],
      networkPassphrase,
      rpcUrl: getRpcUrl(network, this.rpcConfig),
      parseResultXdr: result => result,
    });
    this._checkSimulation(tx.simulation);
    const missingSigners = tx.needsNonInvokerSigningBy();
    if (!missingSigners.includes(sourcePublicKey) || missingSigners.length > 1) {
      throw new Error(
        `Expected to sign with [${sourcePublicKey}], but got [${missingSigners.join(', ')}]`,
      );
    }
    await signAuthEntriesForContractPayer(tx, this.signer, maxLedger, networkPassphrase);
    await tx.simulate();
    this._checkSimulation(tx.simulation);
    const remaining = tx.needsNonInvokerSigningBy();
    if (remaining.length > 0) {
      throw new Error(`unexpected signer(s) required: [${remaining.join(', ')}]`);
    }
    return { x402Version, payload: { transaction: tx.built.toXDR() } };
  }

  _checkSimulation(simulation) {
    if (!simulation) throw new Error('Simulation result is undefined');
    if (simulation.error) {
      throw new Error(`Stellar simulation failed with error message: ${simulation.error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Auth-entry description (the credential-type comparison for the docs)
// ---------------------------------------------------------------------------

function describeAuthEntries(transactionXdr) {
  const tx = new Transaction(transactionXdr, NETWORK_PASSPHRASE);
  const op = tx.operations[0];
  return (op.auth ?? []).map(entry => {
    const credentials = entry.credentials();
    // The x402 payment authorizes a token `transfer`, which arrives as the
    // contractFn arm of SorobanAuthorizedFunction (protocol 28 shape).
    const invocation = entry.rootInvocation().function();
    const fn = invocation.contractFn();
    // Protocol 28 InvokeContractArgs: functionName is a symbol (Buffer).
    const base = {
      credentialType: credentials.switch().name,
      rootInvocation: `${Address.fromScAddress(fn.contractAddress()).toString()}.${fn
        .functionName()
        .toString()}(${fn
        .args()
        .map(a => a.switch().name)
        .join(', ')})`,
    };
    if (base.credentialType !== 'sorobanCredentialsAddress') return base;
    const ac = credentials.address();
    return {
      ...base,
      address: Address.fromScAddress(ac.address()).toString(),
      nonce: ac.nonce().toString(),
      signatureExpirationLedger: ac.signatureExpirationLedger(),
      signature: ac.signature().switch().name,
    };
  });
}

// ---------------------------------------------------------------------------
// The payment flows
// ---------------------------------------------------------------------------

/** Full stock-client payment: 402 -> sign -> retry -> settle. */
async function runStockClientPayment({ payer, label }) {
  const client = new x402Client()
    .register(NETWORK, new ContractAccountExactScheme(payer))
    // Same spend-control opt-in as scripts/e2e.mjs: XLM is priced, not USDC.
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: XLM_SAC }] });
  const http = new x402HTTPClient(client);
  const RESOURCE = `http://127.0.0.1:${RESOURCE_PORT}/api/quote`;

  const unpaid = await fetch(RESOURCE);
  if (unpaid.status !== 402) {
    throw new Error(`${label}: expected 402, got ${unpaid.status}`);
  }
  const body = await unpaid
    .clone()
    .json()
    .catch(() => undefined);
  const paymentRequired = http.getPaymentRequiredResponse(name => unpaid.headers.get(name), body);

  const paymentPayload = await withTransportRetry(`${label}: sign`, () =>
    http.createPaymentPayload(paymentRequired),
  );
  const authEntries = describeAuthEntries(paymentPayload.payload.transaction);

  const paid = await withTransportRetry(`${label}: pay`, () =>
    fetch(RESOURCE, { headers: http.encodePaymentSignatureHeader(paymentPayload) }),
  );
  const text = await paid.text();
  const settle = http.getPaymentSettleResponse(name => paid.headers.get(name));

  if (paid.status !== 200) {
    throw new Error(
      `${label}: payment did not complete: ${settle?.errorReason ?? 'unknown'} ` +
        `${settle?.errorMessage ?? ''} ${text.slice(0, 300)}`.trim(),
    );
  }
  if (!settle?.success || !settle?.transaction) {
    throw new Error(`${label}: settlement reported no transaction hash`);
  }
  return { settle, paymentPayload, authEntries };
}

/** Builds a signed transfer authorization at the SDK level (see scenario C). */
async function buildSignedTransferPayload({ payer, amountStroops }) {
  const server = new rpc.Server(RPC_URL, { allowHttp: true });
  const latestLedger = await server.getLatestLedger();
  const expiration = latestLedger.sequence + Math.ceil(60 / 5);
  const tx = await withTransportRetry('build transfer', () =>
    contract.AssembledTransaction.build({
      contractId: XLM_SAC,
      method: 'transfer',
      args: [
        nativeToScVal(payer.address, { type: 'address' }),
        nativeToScVal(MERCHANT_ADDRESS, { type: 'address' }),
        nativeToScVal(String(amountStroops), { type: 'i128' }),
      ],
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      parseResultXdr: result => result,
    }),
  );
  if (tx.simulation.error) {
    throw new Error(`simulation failed: ${tx.simulation.error}`);
  }
  await signAuthEntriesForContractPayer(tx, payer, expiration, NETWORK_PASSPHRASE);
  // Deliberately NO re-simulation here: the client's final simulate() runs
  // __check_auth and rejects the over-cap authorization — which is the spend
  // cap working — but this negative test wants the facilitator to be the one
  // to reject, so the signed authorization goes to /verify directly.
  return tx.built.toXDR();
}

/** POSTs a payload to /verify and returns { status, body }. */
async function verifyPayload(transactionXdr) {
  // Mirror the v2 payment-payload shape the x402 client produces
  // (x402Version + payload + accepted); the facilitator's scheme reads
  // `paymentPayload.accepted` — a payload without it crashes verification.
  const requirements = {
    scheme: 'exact',
    network: NETWORK,
    asset: XLM_SAC,
    amount: String(PRICE_STROOPS),
    payTo: MERCHANT_ADDRESS,
    maxTimeoutSeconds: 60,
  };
  const body = {
    paymentPayload: {
      x402Version: 2,
      payload: { transaction: transactionXdr },
      accepted: requirements,
    },
    paymentRequirements: requirements,
  };
  const res = await fetch(`${FACILITATOR_URL}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Setup: funding, facilitator, resource server
// ---------------------------------------------------------------------------

try {
  step(0, 'Accounts');
  console.log(`    deployer    = ${deployerKeypair.publicKey()}`);
  console.log(`    owner       = ${ownerKeypair.publicKey()}`);
  console.log(`    merchant    = ${MERCHANT_ADDRESS}`);
  console.log(`    facilitator = ${facilitatorKeypair.publicKey()}`);
  await fundWithFriendbot(deployerKeypair.publicKey());
  await fundWithFriendbot(ownerKeypair.publicKey());
  // The merchant must exist on-chain: a SAC transfer to a non-existent account
  // would need to create it, which requires >= the 1 XLM base reserve.
  await fundWithFriendbot(MERCHANT_ADDRESS);
  if (shouldSpawnFacilitator) await fundWithFriendbot(facilitatorKeypair.publicKey());

  step(1, 'Deploy the __check_auth account contract (3 instances)');
  const wasmHash = await uploadSmartAccountWasm(deployerKeypair);
  const ownerPublicKey = ownerKeypair.publicKey();
  const unlimitedAddress = await createSmartAccountInstance({
    deployerKeypair,
    wasmHash,
    ownerPublicKey,
    spendCap: -1,
  });
  const inCapAddress = await createSmartAccountInstance({
    deployerKeypair,
    wasmHash,
    ownerPublicKey,
    spendCap: IN_CAP_STROOPS,
  });
  const overCapAddress = await createSmartAccountInstance({
    deployerKeypair,
    wasmHash,
    ownerPublicKey,
    spendCap: OVER_CAP_STROOPS,
  });

  for (const address of [unlimitedAddress, inCapAddress, overCapAddress]) {
    await fundContractAddress({
      fromKeypair: deployerKeypair,
      contractAddress: address,
      amountStroops: CONTRACT_FUNDING_STROOPS,
    });
  }

  const payers = {
    unlimited: createContractAccountSigner({
      contractAddress: unlimitedAddress,
      ownerKeypair,
    }),
    inCap: createContractAccountSigner({ contractAddress: inCapAddress, ownerKeypair }),
    overCap: createContractAccountSigner({ contractAddress: overCapAddress, ownerKeypair }),
  };

  // The facilitator must be a distinct account from the payer and the merchant
  // (ExactStellarScheme rejects a facilitator that is a party to the transfer).
  if (shouldSpawnFacilitator) {
    step(2, 'Start the facilitator');
    const facilitatorPort = await freePort();
    FACILITATOR_URL = `http://127.0.0.1:${facilitatorPort}`;
    const facilitator = track(
      spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
        cwd: ROOT,
        env: {
          ...process.env,
          FACILITATOR_SECRET: facilitatorKeypair.secret(),
          PORT: String(facilitatorPort),
          NODE_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    facilitator.stdout.on('data', d => process.stdout.write(`[facilitator] ${d}`));
    facilitator.stderr.on('data', d => process.stderr.write(`[facilitator] ${d}`));
    await waitFor(`${FACILITATOR_URL}/healthz`, { predicate: res => res.status === 200 });
    console.log(`    facilitator ready at ${FACILITATOR_URL}`);
  }

  step(3, 'Start the resource server');
  const resource = new x402ResourceServer([new HTTPFacilitatorClient({ url: FACILITATOR_URL })]);
  resource.register(NETWORK, new ExactStellarServer());
  const httpServer = new x402HTTPResourceServer(resource, {
    '/api/quote': {
      accepts: {
        scheme: 'exact',
        price: { asset: XLM_SAC, amount: String(PRICE_STROOPS) },
        network: NETWORK,
        payTo: MERCHANT_ADDRESS,
      },
    },
  });
  const app = express();
  app.use(paymentMiddlewareFromHTTPServer(httpServer));
  app.get('/api/quote', (_req, res) => {
    res.json({ symbol: 'XLM', price: '0.42', asOf: new Date().toISOString() });
  });
  resourceServer = app.listen(RESOURCE_PORT);
  await new Promise(r => resourceServer.once('listening', r));

  step(4, 'Scenario A — plain smart account (no cap): payment settles');
  const plain = await runStockClientPayment({ payer: payers.unlimited, label: 'plain' });
  console.log(`    tx=${plain.settle.transaction}`);
  console.log(`    payer=${plain.settle.payer}`);

  step(5, 'Scenario B — spend cap above price: payment settles');
  const inCap = await runStockClientPayment({ payer: payers.inCap, label: 'in-cap' });
  console.log(`    tx=${inCap.settle.transaction}`);

  step(6, 'Scenario C — spend cap below price: payment is rejected');
  // C1: the stock client cannot even produce the authorization — its own
  // simulation runs __check_auth, and the contract enforces the cap.
  let clientRejected = null;
  try {
    await runStockClientPayment({ payer: payers.overCap, label: 'over-cap' });
  } catch (err) {
    clientRejected = err.message;
  }
  if (!clientRejected) {
    throw new Error('over-cap: the stock client produced a payload above the spend cap');
  }
  console.log(
    `    stock client rejected the over-cap authorization: ${clientRejected.slice(0, 200)}`,
  );

  // C2: the signed authorization, sent straight to /verify, is rejected with a
  // non-null reason — the cap is enforced server-side, not just client-side.
  const overCapXdr = await buildSignedTransferPayload({
    payer: payers.overCap,
    amountStroops: PRICE_STROOPS,
  });
  const rejected = await verifyPayload(overCapXdr);
  console.log(`    /verify status=${rejected.status} isValid=${rejected.body.isValid}`);
  console.log(`    invalidReason=${rejected.body.invalidReason}`);
  console.log(`    invalidMessage=${rejected.body.invalidMessage}`);
  if (rejected.body.isValid !== false || !rejected.body.invalidReason) {
    throw new Error(
      `over-cap: /verify did not reject with a non-null reason: ${JSON.stringify(rejected.body)}`,
    );
  }
  if (rejected.body.invalidReason === 'unexpected_verify_error') {
    throw new Error(
      `over-cap: the facilitator crashed instead of reporting the spend-cap ` +
        `rejection (${rejected.body.invalidMessage ?? 'no message'}); expected ` +
        `invalid_exact_stellar_payload_simulation_failed`,
    );
  }

  step(7, 'Scenario D — auth-entry comparison (classic keypair vs contract account)');
  const classicClient = new x402Client()
    .register(NETWORK, new ExactStellarClient(createEd25519Signer(ownerKeypair.secret(), NETWORK)))
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: XLM_SAC }] });
  const classicHttp = new x402HTTPClient(classicClient);
  const unpaid = await fetch(`http://127.0.0.1:${RESOURCE_PORT}/api/quote`);
  const body = await unpaid
    .clone()
    .json()
    .catch(() => undefined);
  const paymentRequired = classicHttp.getPaymentRequiredResponse(
    name => unpaid.headers.get(name),
    body,
  );
  const classicPayload = await withTransportRetry('classic: sign', () =>
    classicHttp.createPaymentPayload(paymentRequired),
  );
  const classicEntries = describeAuthEntries(classicPayload.payload.transaction);
  const contractEntries = plain.authEntries;

  console.log('    classic keypair payer:');
  for (const e of classicEntries) console.log(`      ${JSON.stringify(e)}`);
  console.log('    contract-account payer:');
  for (const e of contractEntries) console.log(`      ${JSON.stringify(e)}`);

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('PASS — __check_auth smart-account payer works end to end');
  console.log(
    `  plain (no cap) tx https://stellar.expert/explorer/testnet/tx/${plain.settle.transaction}`,
  );
  console.log(
    `  in-cap         tx https://stellar.expert/explorer/testnet/tx/${inCap.settle.transaction}`,
  );
  console.log(
    `  over-cap       rejected by /verify with invalidReason=${rejected.body.invalidReason}`,
  );
  console.log('────────────────────────────────────────────────────────────');
} catch (err) {
  exitCode = 1;
  console.error(`\nFAIL — ${err instanceof Error ? err.message : err}`);
  if (err?.cause) console.error(`  cause: ${err.cause?.message ?? err.cause}`);
  if (process.env.VERBOSE) console.error(err);
} finally {
  resourceServer?.close();
  await cleanup();
}

process.exit(exitCode);
