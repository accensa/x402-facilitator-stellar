/**
 * The `pact` x402 scheme for Stellar (docs/scheme_pact_stellar.md).
 *
 * A buyer pays into a Pactwright `pact` escrow contract instead of paying the seller directly:
 * the payment is a signed `pact.open` call that moves `cap` from the buyer to the contract. The
 * escrow is released by a verifier's attestation, the buyer's usage, or a deadline, never by
 * the facilitator, which only sponsors the fee.
 *
 * Verification mirrors upstream `ExactStellarScheme` (one invocation, simulated, auth entries
 * checked, facilitator never a party) with the pact rules on top: the right contract and
 * function, `seller == payTo`, `cap == amount`, the frozen condition's hash, exactly one token
 * transfer `buyer → pact` of `cap`, an unused `pact_id`, and a seller trustline.
 *
 * `createPactSubmitter` serves `POST /pact/submit`: fee-sponsored submission of the follow-up
 * calls (`record_verdict`, `settle`, `close_meter`, `release`, `extend_pact_ttl`) on the
 * configured contract only.
 */
import crypto from 'node:crypto';
import {
  Address,
  Operation,
  SignerKey,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { Api } from '@stellar/stellar-sdk/rpc';
import {
  gatherAuthEntrySignatureStatus,
  getAddressCredentials,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
} from '@x402/stellar';

const SUPPORTED_X402_VERSION = 2;
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 250_000; // `open` pays storage rent (~107k stroops on testnet)
const SIGNATURE_EXPIRATION_LEDGER_TOLERANCE = 2;
/** `pact` contract error code for an already-used `pact_id` (Pactwright-contracts errors.rs). */
const PACT_ERROR_ALREADY_EXISTS = 2;

/** Functions `POST /pact/submit` will sponsor. `open` goes through /verify + /settle instead. */
export const PACT_SUBMIT_FUNCTIONS = Object.freeze([
  'record_verdict',
  'settle',
  'close_meter',
  'release',
  'extend_pact_ttl',
]);

/** JSON Canonicalization Scheme (RFC 8785), as Witness and Pactwright-Kit compute it. */
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(v => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter(k => value[k] !== undefined)
      .sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new TypeError(`cannot canonicalize a value of type ${typeof value}`);
}

/** Witness `conditionHash()`: sha256 of the canonical JSON, lowercase hex. */
export function conditionHash(condition) {
  return crypto.createHash('sha256').update(canonicalize(condition), 'utf8').digest('hex');
}

function invalid(reason, payer, message) {
  return { isValid: false, invalidReason: reason, payer, invalidMessage: message };
}

const hex = v => Buffer.from(v).toString('hex');

/**
 * The single `invokeContract` operation of a payload transaction, or an invalid response.
 * Shared by /verify and /pact/submit.
 */
function parseInvocation(transaction, facilitatorAddresses, reasonPrefix) {
  if (transaction.operations.length !== 1) return { error: `${reasonPrefix}_wrong_operation` };
  const op = transaction.operations[0];
  if (op.type !== 'invokeHostFunction') return { error: `${reasonPrefix}_wrong_operation` };
  if (facilitatorAddresses.has(op.source ?? '') || facilitatorAddresses.has(transaction.source)) {
    return { error: `${reasonPrefix}_unsafe_tx_or_op_source` };
  }
  const func = op.func;
  if (!func || func.switch().name !== 'hostFunctionTypeInvokeContract') {
    return { error: `${reasonPrefix}_wrong_operation` };
  }
  const invoke = func.invokeContract();
  return {
    op,
    contract: Address.fromScAddress(invoke.contractAddress()).toString(),
    fn: invoke.functionName().toString(),
    args: invoke.args(),
  };
}

/** Auth entries: address credentials only, never the facilitator, signatures not too long-lived. */
function checkAuthEntries(op, facilitatorAddresses, maxLedger, reasonPrefix) {
  for (const auth of op.auth ?? []) {
    const creds = getAddressCredentials(auth.credentials());
    if (!creds) return `${reasonPrefix}_unsupported_credential_type`;
    if (facilitatorAddresses.has(Address.fromScAddress(creds.address()).toString())) {
      return `${reasonPrefix}_facilitator_in_auth`;
    }
    if (creds.signatureExpirationLedger() > maxLedger + SIGNATURE_EXPIRATION_LEDGER_TOLERANCE) {
      return `${reasonPrefix}_signature_expiration_too_far`;
    }
  }
  return undefined;
}

/** Rebuilds the payload's invocation with a facilitator source account, signs and submits it. */
async function submitSponsored({
  server,
  networkPassphrase,
  transaction,
  invokeOp,
  simResponse,
  signer,
  feeBumpSigner,
  inclusionFeeStroops,
  timeoutSeconds,
}) {
  const account = await server.getAccount(signer.address);
  const rebuilt = new TransactionBuilder(account, {
    fee: String(inclusionFeeStroops),
    networkPassphrase,
    ledgerbounds: transaction.ledgerBounds,
    memo: transaction.memo,
    extraSigners: transaction.extraSigners?.map(k => SignerKey.encodeSignerKey(k)),
    sorobanData: simResponse.transactionData.build(),
  })
    .setTimeout(timeoutSeconds)
    .addOperation(Operation.invokeHostFunction(invokeOp))
    .build();
  const { signedTxXdr, error } = await signer.signTransaction(rebuilt.toXDR(), {
    networkPassphrase,
  });
  if (error) return { errorReason: 'transaction_signing_failed' };
  let toSubmit = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
  if (feeBumpSigner) {
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      feeBumpSigner.address,
      String(inclusionFeeStroops),
      toSubmit,
      networkPassphrase,
    );
    const signedBump = await feeBumpSigner.signTransaction(bump.toXDR(), { networkPassphrase });
    if (signedBump.error) return { errorReason: 'fee_bump_signing_failed' };
    toSubmit = TransactionBuilder.fromXDR(signedBump.signedTxXdr, networkPassphrase);
  }
  const sent = await server.sendTransaction(toSubmit);
  if (sent.status !== 'PENDING') return { errorReason: 'transaction_submission_failed' };
  for (let i = 0; i < timeoutSeconds; i++) {
    try {
      const result = await server.getTransaction(sent.hash);
      if (result.status === 'SUCCESS') return { txHash: sent.hash, result };
      if (result.status === 'FAILED')
        return { txHash: sent.hash, errorReason: 'transaction_failed' };
    } catch {
      // not found yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { txHash: sent.hash, errorReason: 'transaction_failed' };
}

function roundRobin() {
  let i = 0;
  return addresses => addresses[i++ % addresses.length];
}

/**
 * Facilitator side of the `pact` scheme.
 */
export class PactStellarScheme {
  /**
   * @param {object[]} signers - facilitator signers (same type as ExactStellarScheme's)
   * @param {object} options
   * @param {Record<string, string>} options.pactContracts - CAIP-2 network → configured `pact` contract id
   * @param {{url: string}} [options.rpcConfig]
   * @param {number} [options.maxTransactionFeeStroops]
   * @param {number} [options.inclusionFeeStroops]
   * @param {object} [options.feeBumpSigner]
   * @param {Function} [options.selectSigner]
   * @param {object} [options.rpcServer] - RPC client to use instead of the network default (tests)
   */
  constructor(
    signers,
    {
      pactContracts,
      rpcConfig,
      maxTransactionFeeStroops = DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
      inclusionFeeStroops = Number(BASE_FEE),
      feeBumpSigner,
      selectSigner = roundRobin(),
      rpcServer,
    } = {},
  ) {
    if (!signers?.length) throw new Error('At least one signer is required');
    if (!pactContracts || Object.keys(pactContracts).length === 0) {
      throw new Error('pactContracts must name the pact contract for at least one network');
    }
    this.scheme = 'pact';
    this.caipFamily = 'stellar:*';
    this.signerMap = new Map(signers.map(s => [s.address, s]));
    this.signingAddresses = new Set(this.signerMap.keys());
    this.facilitatorAddresses = feeBumpSigner
      ? new Set([...this.signingAddresses, feeBumpSigner.address])
      : this.signingAddresses;
    this.pactContracts = pactContracts;
    this.rpcConfig = rpcConfig;
    this.maxTransactionFeeStroops = maxTransactionFeeStroops;
    this.inclusionFeeStroops = inclusionFeeStroops;
    this.feeBumpSigner = feeBumpSigner;
    this.selectSigner = selectSigner;
    this.rpcServer = rpcServer;
  }

  server(network) {
    return this.rpcServer ?? getRpcClient(network, this.rpcConfig);
  }

  getExtra(network) {
    return { areFeesSponsored: true, pactContract: this.pactContracts[network] };
  }

  getSigners() {
    return [...this.facilitatorAddresses];
  }

  async verify(payload, requirements) {
    return (await this._verify(payload, requirements)).response;
  }

  async settle(payload, requirements) {
    let payer;
    try {
      const verified = await this._verify(payload, requirements);
      payer = verified.response.payer;
      if (!verified.response.isValid) {
        return {
          success: false,
          network: requirements.network,
          transaction: '',
          errorReason: verified.response.invalidReason ?? 'verification_failed',
          payer,
        };
      }
      const signer = this.signerMap.get(this.selectSigner([...this.signingAddresses]));
      const sent = await submitSponsored({
        server: this.server(requirements.network),
        networkPassphrase: getNetworkPassphrase(requirements.network),
        transaction: verified.transaction,
        invokeOp: verified.op,
        simResponse: verified.simResponse,
        signer,
        feeBumpSigner: this.feeBumpSigner,
        inclusionFeeStroops: this.inclusionFeeStroops,
        timeoutSeconds: requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      });
      if (sent.errorReason) {
        return {
          success: false,
          network: requirements.network,
          transaction: sent.txHash ?? '',
          errorReason: `settle_pact_stellar_${sent.errorReason}`,
          payer,
        };
      }
      return {
        success: true,
        transaction: sent.txHash,
        network: requirements.network,
        payer,
        extensions: { pactwright: { pactId: verified.pactId } },
      };
    } catch (error) {
      console.error('Unexpected pact settlement error:', error);
      return {
        success: false,
        network: requirements.network,
        transaction: '',
        errorReason: 'unexpected_settle_error',
        payer,
      };
    }
  }

  async _verify(payload, requirements) {
    let buyer;
    const P = 'invalid_pact_stellar_payload';
    try {
      if (payload.x402Version !== SUPPORTED_X402_VERSION) {
        return { response: invalid('invalid_x402_version') };
      }
      if (payload.accepted?.scheme !== 'pact' || requirements.scheme !== 'pact') {
        return { response: invalid('unsupported_scheme') };
      }
      if (requirements.network !== payload.accepted.network) {
        return { response: invalid('network_mismatch') };
      }
      if (!isStellarNetwork(requirements.network)) return { response: invalid('invalid_network') };
      const pactContract = this.pactContracts[requirements.network];
      if (!pactContract) return { response: invalid(`${P}_network_not_configured`) };
      if (requirements.extra?.pactContract && requirements.extra.pactContract !== pactContract) {
        return { response: invalid(`${P}_wrong_contract`) };
      }

      const networkPassphrase = getNetworkPassphrase(requirements.network);
      const server = this.server(requirements.network);
      if (typeof payload.payload?.transaction !== 'string') {
        return { response: invalid(`${P}_malformed`) };
      }
      let transaction;
      try {
        transaction = new Transaction(payload.payload.transaction, networkPassphrase);
      } catch {
        return { response: invalid(`${P}_malformed`) };
      }
      const inv = parseInvocation(transaction, this.facilitatorAddresses, P);
      if (inv.error) return { response: invalid(inv.error) };
      if (inv.contract !== pactContract) return { response: invalid(`${P}_wrong_contract`) };
      if (inv.fn !== 'open' || inv.args.length !== 1) {
        return { response: invalid(`${P}_wrong_function_name`) };
      }

      // OpenParams, as the contract defines it.
      const params = scValToNative(inv.args[0]);
      buyer = params.buyer;
      if (
        this.facilitatorAddresses.has(params.buyer) ||
        this.facilitatorAddresses.has(params.seller)
      ) {
        return { response: invalid(`${P}_facilitator_is_party`, buyer) };
      }
      if (params.seller !== requirements.payTo) {
        return { response: invalid(`${P}_wrong_recipient`, buyer) };
      }
      const cap = BigInt(requirements.amount);
      if (BigInt(params.cap) !== cap) return { response: invalid(`${P}_wrong_amount`, buyer) };
      const terms = requirements.extra?.pactwright ?? {};
      const committed = hex(params.condition_hash);
      if (terms.condition !== undefined && committed !== conditionHash(terms.condition)) {
        return { response: invalid(`${P}_condition_hash_mismatch`, buyer) };
      }
      if (
        terms.conditionHash !== undefined &&
        committed !== String(terms.conditionHash).toLowerCase()
      ) {
        return { response: invalid(`${P}_condition_hash_mismatch`, buyer) };
      }
      if (terms.silence !== undefined) {
        const expected = terms.silence === 'pay' ? 2 : 1;
        if (Number(params.silence) !== expected)
          return { response: invalid(`${P}_wrong_silence`, buyer) };
      }

      const sim = await server.simulateTransaction(transaction);
      if (!Api.isSimulationSuccess(sim)) {
        const error = String(sim.error ?? '');
        // The host rejects a reused auth-entry nonce before the contract runs; a fresh signature
        // over a used pact_id reaches the contract's AlreadyExists.
        const reason = error.includes('Error(Auth, ExistingValue)')
          ? `${P}_replayed`
          : error.includes(`Error(Contract, #${PACT_ERROR_ALREADY_EXISTS})`)
            ? `${P}_pact_id_used`
            : `${P}_simulation_failed`;
        return { response: invalid(reason, buyer, sim.error) };
      }
      const fee = parseInt(sim.minResourceFee, 10) + this.inclusionFeeStroops;
      if (fee > this.maxTransactionFeeStroops) {
        return {
          response: invalid(
            `${P}_fee_exceeds_maximum`,
            buyer,
            `simulation-derived fee ${fee} stroops exceeds ceiling ${this.maxTransactionFeeStroops} stroops`,
          ),
        };
      }
      const eventProblem = this.checkEvents(sim.events, {
        buyer,
        pactContract,
        cap,
        asset: requirements.asset,
      });
      if (eventProblem) return { response: invalid(eventProblem, buyer) };

      const latest = await server.getLatestLedger();
      const timeout = requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
      const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(requirements.network);
      const maxLedger = latest.sequence + Math.ceil(timeout / ledgerSeconds);
      const authProblem =
        (inv.op.auth?.length ? undefined : `${P}_no_auth_entries`) ??
        checkAuthEntries(inv.op, this.facilitatorAddresses, maxLedger, P) ??
        this.checkAuthTree(inv.op, { buyer, pactContract, cap, asset: requirements.asset });
      if (authProblem) return { response: invalid(authProblem, buyer) };
      const status = gatherAuthEntrySignatureStatus({ transaction, simulationResponse: sim });
      if (!status.alreadySigned.includes(buyer)) {
        return { response: invalid(`${P}_missing_payer_signature`, buyer) };
      }
      if (status.pendingSignature.length > 0) {
        return { response: invalid(`${P}_unexpected_pending_signatures`, buyer) };
      }

      if (
        !(await this.hasTrustline(
          server,
          transaction.source,
          params.seller,
          requirements.asset,
          networkPassphrase,
        ))
      ) {
        return { response: invalid(`${P}_seller_trustline_missing`, buyer) };
      }

      return {
        response: { isValid: true, payer: buyer },
        transaction,
        op: inv.op,
        simResponse: sim,
        pactId: sim.result?.retval ? hex(scValToNative(sim.result.retval)) : undefined,
      };
    } catch (error) {
      console.error('Unexpected pact verification error:', error);
      return { response: invalid('unexpected_verify_error', buyer) };
    }
  }

  /** Exactly one transfer of `cap` from the buyer to the pact contract, plus the pact's own events. */
  checkEvents(events, { buyer, pactContract, cap, asset }) {
    const P = 'invalid_pact_stellar_payload';
    const transfers = [];
    for (const diagnostic of events ?? []) {
      const event = diagnostic.event();
      if (event.type().name !== 'contract') continue;
      const contractId = event.contractId();
      if (!contractId) return `${P}_event_missing_contract_id`;
      const from = Address.fromScAddress(
        xdr.ScAddress.scAddressTypeContract(contractId),
      ).toString();
      const body = event.body().v0();
      const topics = body.topics().map(t => scValToNative(t));
      if (from === pactContract && topics[0] === 'pact') continue;
      if (from !== asset || topics[0] !== 'transfer') return `${P}_unexpected_event`;
      const data = scValToNative(body.data());
      transfers.push({
        from: topics[1],
        to: topics[2],
        amount: typeof data === 'object' && data !== null && 'amount' in data ? data.amount : data,
      });
    }
    if (transfers.length !== 1) return `${P}_${transfers.length ? 'multiple' : 'no'}_transfers`;
    const [t] = transfers;
    if (t.from !== buyer || t.to !== pactContract || BigInt(t.amount) !== cap) {
      return `${P}_wrong_transfer`;
    }
    return undefined;
  }

  /** The buyer authorizes `pact.open` and, beneath it, only `token.transfer(buyer, pact, cap)`. */
  checkAuthTree(op, { buyer, pactContract, cap, asset }) {
    const P = 'invalid_pact_stellar_payload';
    for (const auth of op.auth) {
      const root = auth.rootInvocation();
      const rootFn = root.function();
      if (rootFn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn')
        return `${P}_unexpected_auth`;
      const call = rootFn.contractFn();
      if (Address.fromScAddress(call.contractAddress()).toString() !== pactContract) {
        return `${P}_unexpected_auth`;
      }
      if (call.functionName().toString() !== 'open') return `${P}_unexpected_auth`;
      const subs = root.subInvocations();
      if (subs.length > 1) return `${P}_unexpected_subinvocations`;
      for (const sub of subs) {
        if (sub.subInvocations().length) return `${P}_unexpected_subinvocations`;
        const fn = sub.function();
        if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn')
          return `${P}_unexpected_subinvocations`;
        const t = fn.contractFn();
        const [from, to, amount] = t.args().map(a => scValToNative(a));
        if (
          Address.fromScAddress(t.contractAddress()).toString() !== asset ||
          t.functionName().toString() !== 'transfer' ||
          from !== buyer ||
          to !== pactContract ||
          BigInt(amount) !== cap
        ) {
          return `${P}_unexpected_subinvocations`;
        }
      }
    }
    return undefined;
  }

  /** The seller must be able to receive the asset later (SAC `balance` fails without a trustline). */
  async hasTrustline(server, source, seller, asset, networkPassphrase) {
    if (seller.startsWith('C')) return true; // contracts hold SAC balances without trustlines
    const account = await server.getAccount(source).catch(() => null);
    const sourceAccount =
      account ?? (await server.getAccount(this.signingAddresses.values().next().value));
    const probe = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase })
      .addOperation(
        Operation.invokeContractFunction({
          contract: asset,
          function: 'balance',
          args: [nativeToScVal(seller, { type: 'address' })],
        }),
      )
      .setTimeout(30)
      .build();
    return Api.isSimulationSuccess(await server.simulateTransaction(probe));
  }
}

/**
 * `POST /pact/submit`: fee-sponsored submission of the pact's follow-up calls. The caller signs
 * whatever auth the call needs (the seller for `settle`/`close_meter`); the facilitator only
 * pays the fee, for allow-listed functions on the configured contract.
 *
 * @returns {{ submit: (network: string, txXdr: string) => Promise<object> }}
 */
export function createPactSubmitter(scheme) {
  return {
    async submit(network, txXdr) {
      const P = 'invalid_pact_submit';
      const pactContract = scheme.pactContracts[network];
      if (!pactContract) return { success: false, errorReason: `${P}_network_not_configured` };
      const networkPassphrase = getNetworkPassphrase(network);
      const server = scheme.server(network);
      let transaction;
      try {
        transaction = new Transaction(txXdr, networkPassphrase);
      } catch {
        return { success: false, errorReason: `${P}_malformed` };
      }
      const inv = parseInvocation(transaction, scheme.facilitatorAddresses, P);
      if (inv.error) return { success: false, errorReason: inv.error };
      if (inv.contract !== pactContract)
        return { success: false, errorReason: `${P}_wrong_contract` };
      if (!PACT_SUBMIT_FUNCTIONS.includes(inv.fn)) {
        return { success: false, errorReason: `${P}_function_not_allowed` };
      }
      const sim = await server.simulateTransaction(transaction);
      if (!Api.isSimulationSuccess(sim)) {
        return { success: false, errorReason: `${P}_simulation_failed`, errorMessage: sim.error };
      }
      const fee = parseInt(sim.minResourceFee, 10) + scheme.inclusionFeeStroops;
      if (fee > scheme.maxTransactionFeeStroops) {
        return { success: false, errorReason: `${P}_fee_exceeds_maximum` };
      }
      const latest = await server.getLatestLedger();
      const maxLedger =
        latest.sequence +
        Math.ceil(DEFAULT_TIMEOUT_SECONDS / (await getEstimatedLedgerCloseTimeSeconds(network)));
      const authProblem = checkAuthEntries(inv.op, scheme.facilitatorAddresses, maxLedger, P);
      if (authProblem) return { success: false, errorReason: authProblem };
      const status = gatherAuthEntrySignatureStatus({ transaction, simulationResponse: sim });
      if (status.pendingSignature.length > 0) {
        return { success: false, errorReason: `${P}_unexpected_pending_signatures` };
      }
      const signer = scheme.signerMap.get(scheme.selectSigner([...scheme.signingAddresses]));
      const sent = await submitSponsored({
        server,
        networkPassphrase,
        transaction,
        invokeOp: inv.op,
        simResponse: sim,
        signer,
        feeBumpSigner: scheme.feeBumpSigner,
        inclusionFeeStroops: scheme.inclusionFeeStroops,
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      });
      if (sent.errorReason) {
        return {
          success: false,
          transaction: sent.txHash ?? '',
          errorReason: `pact_submit_${sent.errorReason}`,
        };
      }
      return {
        success: true,
        transaction: sent.txHash,
        network,
        function: inv.fn,
        feeStroops: fee,
      };
    },
  };
}
