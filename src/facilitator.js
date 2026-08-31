/**
 * Wires @x402/stellar's ExactStellarScheme into an x402Facilitator.
 * ExactStellarScheme owns protocol verification and settlement; this module only
 * manages the signer generations supplied to it.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { createEd25519Signer } from '@x402/stellar';
import { TESTNET, PUBNET } from './config.js';
import { signerMetrics } from './metrics.js';
import { KeyManager } from './key-manager.js';

async function loadRemoteKeys(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`key source returned HTTP ${response.status}`);
  const body = await response.json();
  return body.keys;
}

export function buildFacilitator(config) {
  const facilitator = new x402Facilitator();
  const signers = {};
  const feeBumpSigners = {};
  const keyManagers = {};
  const schemes = {};

  for (const network of config.networks) {
    const netConfig = config.perNetwork[network];
    const keyManager = new KeyManager({
      network,
      secrets: netConfig.secrets ?? [netConfig.secret],
      loadKeys: netConfig.keyManagerUrl ? () => loadRemoteKeys(netConfig.keyManagerUrl) : undefined,
      pollIntervalMs: netConfig.keyManagerPollIntervalMs,
    });
    keyManagers[network] = keyManager;

    let feeBumpSigner = null;
    if (netConfig.feeBumpSecret) {
      feeBumpSigner = createEd25519Signer(netConfig.feeBumpSecret, network);
      feeBumpSigners[network] = feeBumpSigner.address;
    } else {
      feeBumpSigners[network] = null;
    }

    const createScheme = snapshot => {
      let rrIndex = 0;
      const signersForScheme = snapshot.entries.map(entry => entry.signer);
      const selectSigner = addresses => {
        const address = addresses[rrIndex % addresses.length];
        rrIndex = (rrIndex + 1) % addresses.length;
        signerMetrics.recordSelection(network, address);
        return address;
      };
      const scheme = new ExactStellarScheme(signersForScheme, {
        rpcConfig: netConfig.rpcUrl ? { url: netConfig.rpcUrl } : undefined,
        maxTransactionFeeStroops: netConfig.maxTransactionFeeStroops,
        feeBumpSigner,
        selectSigner,
      });
      return { scheme };
    };

    const initial = keyManager.snapshot();
    schemes[network] = createScheme(initial);
    signers[network] = [...keyManager.getCurrent().entries.values()].map(
      entry => entry.signer.address,
    );

    keyManager.onRefresh = () => {
      const next = createScheme(keyManager.snapshot());
      schemes[network] = next;
      signers[network] = [...keyManager.getCurrent().entries.values()].map(
        entry => entry.signer.address,
      );
      facilitator.register(network, next.scheme);
    };
    keyManager.start();
    facilitator.register(network, schemes[network].scheme);
  }

  return { facilitator, signers, feeBumpSigners, keyManagers, schemes };
}

export { TESTNET, PUBNET };
