/**
 * @file pact-scheme.testnet.test.js
 * @description The `pact` scheme end to end on Stellar testnet, against the deployed Pactwright
 * `pact` contract and real testnet USDC. Skipped unless PACT_TESTNET_FACILITATOR_SECRET (a
 * funded account that pays fees) and PACT_TESTNET_VERIFIER_SECRET (the verifier configured in
 * the contract) are set. Not part of `npm test`'s glob (test/**\/*.test.js excludes nothing, so
 * the skip is what keeps CI offline).
 *
 *   PACT_TESTNET_FACILITATOR_SECRET=S… PACT_TESTNET_VERIFIER_SECRET=S… \
 *     node --test test/integration/pact-scheme.testnet.test.js
 *
 * 1. A buyer signs `pact.open` the way an x402 client does (auth entries only, no tx source).
 * 2. /verify accepts it; /settle submits it with a facilitator-paid fee.
 * 3. The same payment is then rejected as a replay (its auth entry was consumed).
 * 4. /pact/submit sponsors `record_verdict` (verifier-signed ALLOW 0.75) and the seller's `settle`.
 * 5. The contract shows the pact Settled: 0.75 to the seller, 0.25 back to the buyer.
 */

import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';
import { contract } from '@stellar/stellar-sdk';
import { createEd25519Signer } from '@x402/stellar';
import { PactStellarScheme, conditionHash, createPactSubmitter } from '../../src/pact-scheme.js';

const NETWORK = 'stellar:testnet';
const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const PACT =
  process.env.PACT_CONTRACT_ID ?? 'CDUXJJUNYFILEYHE3LITANJEKCDFERNAABOSG75OWATFVM776BCMFEV6';
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const CAP = 10_000_000n;
const CONDITION = { kind: 'document.translation', lang: 'pt', minPages: 4 };

const facilitatorSecret = process.env.PACT_TESTNET_FACILITATOR_SECRET;
const verifierSecret = process.env.PACT_TESTNET_VERIFIER_SECRET;
const server = new Server(RPC_URL);

async function classic(kp, op) {
  const tx = new TransactionBuilder(await server.getAccount(kp.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  const final = await server.pollTransaction(sent.hash, { attempts: 30 });
  assert.equal(final.status, 'SUCCESS', `classic op failed: ${sent.hash}`);
}

async function fundedAccount(xlmForUsdc) {
  const kp = Keypair.random();
  await server.requestAirdrop(kp.publicKey());
  await classic(kp, Operation.changeTrust({ asset: USDC }));
  if (xlmForUsdc) {
    await classic(
      kp,
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: xlmForUsdc,
        destination: kp.publicKey(),
        destAsset: USDC,
        destMin: '1',
        path: [],
      }),
    );
  }
  return kp;
}

const sym = s => xdr.ScVal.scvSymbol(s);
const map = entries =>
  xdr.ScVal.scvMap(
    Object.keys(entries)
      .sort()
      .map(k => new xdr.ScMapEntry({ key: sym(k), val: entries[k] })),
  );

/**
 * Builds a contract call the way x402 clients do: no transaction source of the payer's, the
 * payer's (or seller's) authorization as a signed auth entry, re-simulated after signing.
 */
async function signedCall(method, args, signerKey, maxLedger) {
  const tx = await contract.AssembledTransaction.build({
    contractId: PACT,
    method,
    args,
    networkPassphrase: Networks.TESTNET,
    rpcUrl: RPC_URL,
    parseResultXdr: r => r,
  });
  if (signerKey) {
    const signer = createEd25519Signer(signerKey.secret(), NETWORK);
    await tx.signAuthEntries({
      address: signerKey.publicKey(),
      signAuthEntry: signer.signAuthEntry,
      expiration: maxLedger,
    });
    await tx.simulate();
  }
  return tx.built.toXDR();
}

/** The verifier's attestation message: sha256("pactwright-verdict-v1:" ‖ xdr(attestation)). */
function signAttestation(att, verifier) {
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from('pactwright-verdict-v1:'), att.toXDR()]))
    .digest();
  return verifier.sign(digest);
}

test(
  'pact scheme: verify, settle, replay rejection and /pact/submit on testnet',
  { skip: !(facilitatorSecret && verifierSecret), timeout: 600_000 },
  async () => {
    const facilitatorSigner = createEd25519Signer(facilitatorSecret, NETWORK);
    const scheme = new PactStellarScheme([facilitatorSigner], {
      pactContracts: { [NETWORK]: PACT },
      rpcConfig: { url: RPC_URL },
    });
    const verifier = Keypair.fromSecret(verifierSecret);
    const buyer = await fundedAccount('60');
    const seller = await fundedAccount(null);

    // 1. The buyer's x402 payment: a signed `pact.open`.
    const latest = (await server.getLatestLedger()).sequence;
    const params = map({
      buyer: nativeToScVal(buyer.publicKey(), { type: 'address' }),
      cap: nativeToScVal(CAP, { type: 'i128' }),
      condition_hash: xdr.ScVal.scvBytes(Buffer.from(conditionHash(CONDITION), 'hex')),
      meter: xdr.ScVal.scvVec([sym('None')]),
      nonce: nativeToScVal(BigInt(Date.now()), { type: 'u64' }),
      seller: nativeToScVal(seller.publicKey(), { type: 'address' }),
      settle_deadline: xdr.ScVal.scvU32(latest + 720),
      silence: xdr.ScVal.scvU32(1),
      verdict_deadline: xdr.ScVal.scvU32(latest + 120),
    });
    const transaction = await signedCall('open', [params], buyer, latest + 10); // ~maxTimeoutSeconds
    const requirements = {
      scheme: 'pact',
      network: NETWORK,
      asset: USDC_SAC,
      amount: CAP.toString(),
      payTo: seller.publicKey(),
      maxTimeoutSeconds: 60,
      extra: {
        areFeesSponsored: true,
        pactContract: PACT,
        pactwright: { condition: CONDITION, silence: 'refund' },
      },
    };
    const payment = { x402Version: 2, accepted: requirements, payload: { transaction } };

    // 2. Verify and settle.
    const verified = await scheme.verify(payment, requirements);
    assert.deepEqual(
      verified,
      { isValid: true, payer: buyer.publicKey() },
      JSON.stringify(verified),
    );
    const settled = await scheme.settle(payment, requirements);
    assert.equal(settled.success, true, JSON.stringify(settled));
    const pactId = settled.extensions.pactwright.pactId;
    assert.match(pactId, /^[0-9a-f]{64}$/);
    console.log(`open settled by the facilitator: ${settled.transaction} (pact ${pactId})`);
    const openLedger = (await server.getTransaction(settled.transaction)).ledger;

    // 3. Replaying the same payment is rejected: its signed auth entry was consumed.
    const replay = await scheme.verify(payment, requirements);
    assert.equal(replay.invalidReason, 'invalid_pact_stellar_payload_replayed');

    // 4. /pact/submit: verifier-signed ALLOW 0.75, then the seller's settle.
    const submitter = createPactSubmitter(scheme);
    const attestation = map({
      amount: nativeToScVal(7_500_000n, { type: 'i128' }),
      condition_hash: xdr.ScVal.scvBytes(Buffer.from(conditionHash(CONDITION), 'hex')),
      envelope_hash: xdr.ScVal.scvBytes(crypto.randomBytes(32)),
      issued_ledger: xdr.ScVal.scvU32(openLedger),
      pact_id: xdr.ScVal.scvBytes(Buffer.from(pactId, 'hex')),
      verdict: xdr.ScVal.scvU32(1),
    });
    const verdictTx = await signedCall(
      'record_verdict',
      [
        xdr.ScVal.scvBytes(Buffer.from(pactId, 'hex')),
        attestation,
        xdr.ScVal.scvBytes(signAttestation(attestation, verifier)),
      ],
      null,
    );
    const recorded = await submitter.submit(NETWORK, verdictTx);
    assert.equal(recorded.success, true, JSON.stringify(recorded));
    console.log(`record_verdict via /pact/submit: ${recorded.transaction}`);

    const now = (await server.getLatestLedger()).sequence;
    const settleTx = await signedCall(
      'settle',
      [xdr.ScVal.scvBytes(Buffer.from(pactId, 'hex')), nativeToScVal(7_500_000n, { type: 'i128' })],
      seller,
      now + 10,
    );
    const paid = await submitter.submit(NETWORK, settleTx);
    assert.equal(paid.success, true, JSON.stringify(paid));
    console.log(`settle via /pact/submit: ${paid.transaction}`);

    // 5. The contract agrees.
    const pact = await contract.AssembledTransaction.build({
      contractId: PACT,
      method: 'get_pact',
      args: [xdr.ScVal.scvBytes(Buffer.from(pactId, 'hex'))],
      networkPassphrase: Networks.TESTNET,
      rpcUrl: RPC_URL,
      parseResultXdr: r => scValToNative(r),
    });
    const state = pact.result;
    assert.equal(Number(state.paid_to_seller), 7_500_000);
    assert.equal(Number(state.returned_to_buyer), 2_500_000);
  },
);
