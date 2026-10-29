/**
 * @file pact-scheme.test.js
 * @description Negative tests for the `pact` scheme (docs/scheme_pact_stellar.md): one per
 * verification rule and per `/pact/submit` allow-list rule. Offline: the RPC server is a stub,
 * so only rules decided before or by simulation are exercised here. The happy path, the event
 * and auth-tree checks against real simulations, and settlement run on testnet in
 * test/integration/pact-scheme.testnet.test.js.
 */

import test from 'node:test';
import assert from 'node:assert';
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { createEd25519Signer } from '@x402/stellar';
import {
  PactStellarScheme,
  PACT_SUBMIT_FUNCTIONS,
  canonicalize,
  conditionHash,
  createPactSubmitter,
} from '../src/pact-scheme.js';

const NETWORK = 'stellar:testnet';
const PACT = 'CDUXJJUNYFILEYHE3LITANJEKCDFERNAABOSG75OWATFVM776BCMFEV6';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const OTHER_CONTRACT = 'CAEO5GBC3ULRC5RYBSCSOXLNXHU2HZAHNW5HY5LZM3DIPFMX357ILNJ2';

const facilitatorKey = Keypair.random();
const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const CONDITION = { kind: 'document.translation', lang: 'pt', minPages: 4 };
const CAP = 10_000_000n;

function sym(s) {
  return xdr.ScVal.scvSymbol(s);
}

/** `OpenParams` exactly as the contract's `#[contracttype]` struct encodes it (sorted map). */
function openParams(overrides = {}) {
  const p = {
    buyer,
    seller,
    cap: CAP,
    nonce: 7n,
    condition_hash: Buffer.from(conditionHash(CONDITION), 'hex'),
    silence: 1,
    verdict_deadline: 1000,
    settle_deadline: 2000,
    ...overrides,
  };
  const entries = {
    buyer: nativeToScVal(p.buyer, { type: 'address' }),
    cap: nativeToScVal(p.cap, { type: 'i128' }),
    condition_hash: xdr.ScVal.scvBytes(p.condition_hash),
    meter: xdr.ScVal.scvVec([sym('None')]),
    nonce: nativeToScVal(p.nonce, { type: 'u64' }),
    seller: nativeToScVal(p.seller, { type: 'address' }),
    settle_deadline: xdr.ScVal.scvU32(p.settle_deadline),
    silence: xdr.ScVal.scvU32(p.silence),
    verdict_deadline: xdr.ScVal.scvU32(p.verdict_deadline),
  };
  return xdr.ScVal.scvMap(
    Object.keys(entries)
      .sort()
      .map(k => new xdr.ScMapEntry({ key: sym(k), val: entries[k] })),
  );
}

function txXdr({ contract = PACT, fn = 'open', args = [openParams()], source, ops = 1 } = {}) {
  const account = new Account(source ?? Keypair.random().publicKey(), '1');
  let builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  for (let i = 0; i < ops; i++) {
    builder = builder.addOperation(
      Operation.invokeContractFunction({ contract, function: fn, args }),
    );
  }
  return builder.setTimeout(60).build().toXDR();
}

function requirements(overrides = {}) {
  return {
    scheme: 'pact',
    network: NETWORK,
    asset: USDC,
    amount: CAP.toString(),
    payTo: seller,
    maxTimeoutSeconds: 60,
    extra: {
      areFeesSponsored: true,
      pactContract: PACT,
      pactwright: { condition: CONDITION, silence: 'refund' },
    },
    ...overrides,
  };
}

function payload(transaction, accepted = requirements()) {
  return { x402Version: 2, accepted, payload: { transaction } };
}

/** Stub RPC: every simulation fails with the given error. */
function stubServer(simError = 'HostError: Error(Contract, #4)') {
  return {
    simulateTransaction: async () => ({ error: simError }),
    getLatestLedger: async () => ({ sequence: 100 }),
    getAccount: async address => new Account(address, '1'),
  };
}

function scheme(rpcServer = stubServer()) {
  return new PactStellarScheme([createEd25519Signer(facilitatorKey.secret(), NETWORK)], {
    pactContracts: { [NETWORK]: PACT },
    rpcServer,
  });
}

async function reason(tx, reqs = requirements(), s = scheme(), accepted = reqs) {
  const res = await s.verify(payload(tx, accepted), reqs);
  assert.equal(res.isValid, false);
  return res.invalidReason;
}

test('canonical condition hashing matches Witness / Pactwright-Kit (RFC 8785 key order)', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(conditionHash({ b: 1, a: 2 }), conditionHash({ a: 2, b: 1 }));
});

test('scheme refuses to start without a configured pact contract', () => {
  assert.throws(
    () => new PactStellarScheme([createEd25519Signer(facilitatorKey.secret(), NETWORK)], {}),
  );
});

test('getExtra advertises the configured contract and fee sponsorship', () => {
  assert.deepEqual(scheme().getExtra(NETWORK), { areFeesSponsored: true, pactContract: PACT });
});

test('rejects the wrong x402 version, scheme and network', async () => {
  const s = scheme();
  assert.equal(
    (await s.verify({ ...payload(txXdr()), x402Version: 1 }, requirements())).invalidReason,
    'invalid_x402_version',
  );
  assert.equal(await reason(txXdr(), requirements({ scheme: 'exact' })), 'unsupported_scheme');
  assert.equal(
    await reason(txXdr(), requirements(), s, requirements({ network: 'stellar:pubnet' })),
    'network_mismatch',
  );
  assert.equal(
    await reason(txXdr(), requirements({ network: 'stellar:pubnet' })),
    'invalid_pact_stellar_payload_network_not_configured',
  );
});

test('rejects requirements that name another pact contract', async () => {
  const reqs = requirements({ extra: { ...requirements().extra, pactContract: OTHER_CONTRACT } });
  assert.equal(await reason(txXdr(), reqs), 'invalid_pact_stellar_payload_wrong_contract');
});

test('rejects malformed transactions', async () => {
  assert.equal(await reason('not-xdr'), 'invalid_pact_stellar_payload_malformed');
});

test('rejects more than one operation', async () => {
  assert.equal(await reason(txXdr({ ops: 2 })), 'invalid_pact_stellar_payload_wrong_operation');
});

test('rejects a transaction whose source is the facilitator', async () => {
  assert.equal(
    await reason(txXdr({ source: facilitatorKey.publicKey() })),
    'invalid_pact_stellar_payload_unsafe_tx_or_op_source',
  );
});

test('rejects calls to any other contract', async () => {
  assert.equal(
    await reason(txXdr({ contract: OTHER_CONTRACT })),
    'invalid_pact_stellar_payload_wrong_contract',
  );
});

test('rejects any function but open', async () => {
  assert.equal(
    await reason(txXdr({ fn: 'settle' })),
    'invalid_pact_stellar_payload_wrong_function_name',
  );
});

test('rejects a pact where the facilitator is buyer or seller', async () => {
  const asBuyer = txXdr({ args: [openParams({ buyer: facilitatorKey.publicKey() })] });
  assert.equal(await reason(asBuyer), 'invalid_pact_stellar_payload_facilitator_is_party');
  const asSeller = txXdr({ args: [openParams({ seller: facilitatorKey.publicKey() })] });
  assert.equal(
    await reason(asSeller, requirements({ payTo: facilitatorKey.publicKey() })),
    'invalid_pact_stellar_payload_facilitator_is_party',
  );
});

test('rejects a seller other than payTo', async () => {
  assert.equal(
    await reason(txXdr({ args: [openParams({ seller: Keypair.random().publicKey() })] })),
    'invalid_pact_stellar_payload_wrong_recipient',
  );
});

test('rejects a cap other than the required amount', async () => {
  assert.equal(
    await reason(txXdr({ args: [openParams({ cap: CAP - 1n })] })),
    'invalid_pact_stellar_payload_wrong_amount',
  );
});

test('rejects a condition hash that does not match the frozen condition', async () => {
  const tx = txXdr({ args: [openParams({ condition_hash: Buffer.alloc(32, 9) })] });
  assert.equal(await reason(tx), 'invalid_pact_stellar_payload_condition_hash_mismatch');
  const reqs = requirements({
    extra: { pactContract: PACT, pactwright: { conditionHash: 'ab'.repeat(32) } },
  });
  assert.equal(await reason(txXdr(), reqs), 'invalid_pact_stellar_payload_condition_hash_mismatch');
});

test('rejects a silence policy other than the seller offered', async () => {
  assert.equal(
    await reason(txXdr({ args: [openParams({ silence: 2 })] })),
    'invalid_pact_stellar_payload_wrong_silence',
  );
});

test('reports an already-used pact_id from the contract error', async () => {
  const s = scheme(stubServer('HostError: Error(Contract, #2)'));
  assert.equal(
    await reason(txXdr(), requirements(), s),
    'invalid_pact_stellar_payload_pact_id_used',
  );
});

test('reports a replayed payment (consumed auth-entry nonce)', async () => {
  const s = scheme(stubServer('HostError: Error(Auth, ExistingValue)'));
  assert.equal(await reason(txXdr(), requirements(), s), 'invalid_pact_stellar_payload_replayed');
});

test('rejects anything the contract would reject in simulation', async () => {
  assert.equal(await reason(txXdr()), 'invalid_pact_stellar_payload_simulation_failed');
});

test('settle never submits an invalid payment', async () => {
  const res = await scheme().settle(payload(txXdr({ fn: 'release' })), requirements());
  assert.equal(res.success, false);
  assert.equal(res.transaction, '');
  assert.equal(res.errorReason, 'invalid_pact_stellar_payload_wrong_function_name');
});

// ---- POST /pact/submit allow-list -------------------------------------------------

test('/pact/submit allows only the pact follow-up calls', () => {
  assert.deepEqual([...PACT_SUBMIT_FUNCTIONS].sort(), [
    'close_meter',
    'extend_pact_ttl',
    'record_verdict',
    'release',
    'settle',
  ]);
  assert.equal(PACT_SUBMIT_FUNCTIONS.includes('open'), false);
});

test('/pact/submit rejects other contracts, other functions and facilitator sources', async () => {
  const submitter = createPactSubmitter(scheme());
  const id = Buffer.alloc(32, 1);
  const args = [xdr.ScVal.scvBytes(id)];
  assert.equal(
    (await submitter.submit(NETWORK, txXdr({ contract: OTHER_CONTRACT, fn: 'release', args })))
      .errorReason,
    'invalid_pact_submit_wrong_contract',
  );
  for (const fn of ['open', 'set_verifier', 'transfer']) {
    assert.equal(
      (await submitter.submit(NETWORK, txXdr({ fn, args }))).errorReason,
      'invalid_pact_submit_function_not_allowed',
    );
  }
  assert.equal(
    (
      await submitter.submit(
        NETWORK,
        txXdr({ fn: 'release', args, source: facilitatorKey.publicKey() }),
      )
    ).errorReason,
    'invalid_pact_submit_unsafe_tx_or_op_source',
  );
  assert.equal(
    (await submitter.submit(NETWORK, 'garbage')).errorReason,
    'invalid_pact_submit_malformed',
  );
  assert.equal(
    (await submitter.submit('stellar:pubnet', txXdr({ fn: 'release', args }))).errorReason,
    'invalid_pact_submit_network_not_configured',
  );
});

test('/pact/submit sends nothing the contract would reject', async () => {
  const res = await createPactSubmitter(scheme()).submit(
    NETWORK,
    txXdr({ fn: 'release', args: [xdr.ScVal.scvBytes(Buffer.alloc(32, 1))] }),
  );
  assert.equal(res.success, false);
  assert.equal(res.errorReason, 'invalid_pact_submit_simulation_failed');
});

// ---- Bazaar listing (X-06) ---------------------------------------------------------

test('catalog listings carry well-typed Pactwright terms only', async () => {
  const { pactwrightListing } = await import('../src/catalog/validation.js');
  assert.deepEqual(
    pactwrightListing({
      scheme: 'pact',
      extra: {
        pactwright: {
          verifier: 'AB'.repeat(32),
          silence: 'refund',
          refundWindowLedgers: 17280,
          float: '25.5',
          evil: '<script>',
        },
      },
    }),
    {
      mode: 'escrow',
      verifier: 'ab'.repeat(32),
      silence: 'refund',
      refundWindowLedgers: 17280,
      float: '25.5',
    },
  );
  assert.deepEqual(
    pactwrightListing({
      scheme: 'exact',
      extra: { pactwright: { silence: 'sometimes', float: '1e9', refundWindowLedgers: -1 } },
    }),
    { mode: 'exact-refund' },
  );
  assert.equal(pactwrightListing({ scheme: 'exact', extra: {} }), undefined);
});

// ---- configuration --------------------------------------------------------------

test('PACT_CONTRACT_ID must be a contract id; pact fees get their own ceiling', async () => {
  const { resolveConfig, TESTNET } = await import('../src/config.js');
  const base = { FACILITATOR_SECRET: Keypair.random().secret() };
  const off = resolveConfig(base).perNetwork[TESTNET];
  assert.equal(off.pactContractId, null);
  assert.equal(off.pactMaxTransactionFeeStroops, 250_000);
  assert.equal(
    resolveConfig({ ...base, PACT_CONTRACT_ID: PACT }).perNetwork[TESTNET].pactContractId,
    PACT,
  );
  assert.throws(
    () => resolveConfig({ ...base, PACT_CONTRACT_ID: Keypair.random().publicKey() }),
    /PACT_CONTRACT_ID/,
  );
});
