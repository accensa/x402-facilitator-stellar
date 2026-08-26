/**
 * Wires @x402/stellar's ExactStellarScheme into an x402Facilitator.
 *
 * Deliberately thin. ExactStellarScheme already implements verify and settle —
 * including auth-entry structure and credential-type checks, expiration against
 * a max ledger, facilitator-safety (the facilitator must not be party to the
 * transfer), rejection of sub-invocations, payer-signature status, and
 * simulation-event validation that exactly one transfer event matches the
 * expected sender, recipient, amount and asset.
 *
 * None of that is reimplemented here. Reimplementing it is what the RFP tells
 * respondents not to do, and it is also the part most dangerous to get subtly
 * wrong.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { createEd25519Signer } from '@x402/stellar';
import { TESTNET, PUBNET } from './config.js';
import { signerMetrics } from './metrics.js';

/**
 * Builds the facilitator.
 *
 * One scheme instance per network rather than one shared across both: the
 * signer pool, fee-bump signer, RPC endpoint and fee ceiling are all
 * network-specific.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @returns {{ facilitator: x402Facilitator, signers: Record<string, string[]>, feeBumpSigners: Record<string, string|null> }}
 */
export function buildFacilitator(config) {
  const facilitator = new x402Facilitator();
  const signers = {};
  const feeBumpSigners = {};

  for (const network of config.networks) {
    const netConfig = config.perNetwork[network];

    const secrets = netConfig.secrets ?? [netConfig.secret];
    const poolSigners = secrets.map(secret => createEd25519Signer(secret, network));
    signers[network] = poolSigners.map(s => s.address);

    let feeBumpSigner = null;
    if (netConfig.feeBumpSecret) {
      feeBumpSigner = createEd25519Signer(netConfig.feeBumpSecret, network);
      feeBumpSigners[network] = feeBumpSigner.address;
    } else {
      feeBumpSigners[network] = null;
    }

    let rrIndex = 0;
    // Package default selection is round-robin; wrapped here to track metrics.
    const selectSigner = signersList => {
      const selected = signersList[rrIndex % signersList.length];
      rrIndex = (rrIndex + 1) % signersList.length;
      signerMetrics.recordSelection(network, selected.address);
      return selected;
    };

    const scheme = new ExactStellarScheme(poolSigners, {
      rpcConfig: netConfig.rpcUrl ? { url: netConfig.rpcUrl } : undefined,
      maxTransactionFeeStroops: netConfig.maxTransactionFeeStroops,
      feeBumpSigner,
      selectSigner,
    });

    facilitator.register(network, scheme);
  }

  return { facilitator, signers, feeBumpSigners };
}

export { TESTNET, PUBNET };
