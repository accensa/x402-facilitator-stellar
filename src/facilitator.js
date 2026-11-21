/**
 * Wires @x402/stellar's ExactStellarScheme into an x402Facilitator.
 * ExactStellarScheme owns protocol verification and settlement; this module only
 * manages the signer generations supplied to it.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { PactStellarScheme } from './pact-scheme.js';
import { createEd25519Signer } from '@x402/stellar';
import { TESTNET, PUBNET } from './config.js';
import { signerMetrics } from './metrics.js';
import { KeyManager } from './key-manager.js';
import { createFeeEstimator } from './horizon-client.js';
import { createMultiSignerEngine } from './multi-signer.js';
import { createAssetDecimalsCache } from './asset-cache.js';
import { StrKey } from '@stellar/stellar-sdk';

async function loadRemoteKeys(url, timeoutMs = keySourceTimeoutMs()) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`key source fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!response.ok) throw new Error(`key source returned HTTP ${response.status}`);
  // A proxy or captive portal can answer 200 with an HTML error page. Calling
  // `response.json()` blindly then threw bare `Unexpected token '<'`, naming
  // neither the source nor the status — useless in an operator's log (#659).
  // Check the media type first and wrap the parse, naming the URL and content
  // type; the parse message is not reused because it can quote the body.
  const contentType = response.headers?.get?.('content-type') ?? '';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
    throw new Error(
      `key source ${url} returned non-JSON content type "${contentType || 'none'}" (expected application/json)`,
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`key source ${url} returned invalid JSON (content type "${contentType}")`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('key source payload invalid: missing "keys" field');
  }
  if (!Array.isArray(body.keys)) {
    throw new Error('key source payload invalid: "keys" must be an array');
  }
  if (body.keys.length === 0) {
    throw new Error('key source payload invalid: "keys" must be non-empty');
  }
  for (let index = 0; index < body.keys.length; index++) {
    const entry = body.keys[index];
    if (typeof entry === 'string') {
      if (!StrKey.isValidEd25519SecretSeed(entry)) {
        throw new Error(`key source payload invalid: keys[${index}] has an invalid secret seed`);
      }
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `key source payload invalid: keys[${index}] must be a string or an object with "secret"`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'secret')) {
      throw new Error(`key source payload invalid: keys[${index}].secret is required`);
    }
    if (typeof entry.secret !== 'string' || !StrKey.isValidEd25519SecretSeed(entry.secret)) {
      throw new Error(`key source payload invalid: keys[${index}].secret is invalid`);
    }
  }
  return body.keys;
}

/**
 * Bounded timeout for the remote key-source fetch (#493). House convention
 * is AbortSignal.timeout (see embeddings, failover-health, readiness), so
 * this uses the same one-liner rather than a bespoke controller.
 */
function keySourceTimeoutMs() {
  const raw = Number(process.env.KEY_MANAGER_FETCH_TIMEOUT_MS ?? 5_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

export function buildFacilitator(config) {
  const facilitator = new x402Facilitator();
  const signers = {};
  const feeBumpSigners = {};
  const keyManagers = {};
  const feeEstimators = {};
  const schemes = {};
  const assetCaches = {};

  for (const network of config.networks) {
    const netConfig = config.perNetwork[network];
    const keyManager = new KeyManager({
      network,
      secrets: netConfig.secrets ?? [netConfig.secret],
      loadKeys: netConfig.keyManagerUrl ? () => loadRemoteKeys(netConfig.keyManagerUrl) : undefined,
      pollIntervalMs: netConfig.keyManagerPollIntervalMs,
    });
    keyManagers[network] = keyManager;

    // Dynamic fee bidding (#426). The scheme only takes a hard ceiling, so the
    // estimator supplies the recommended bid and enforces that same ceiling.
    if (netConfig.horizonUrl) {
      feeEstimators[network] = createFeeEstimator({
        horizonUrl: netConfig.horizonUrl,
        maxFeeStroops: netConfig.maxTransactionFeeStroops,
      });
    }

    let feeBumpSigner = null;
    if (netConfig.feeBumpSecret) {
      feeBumpSigner = createEd25519Signer(netConfig.feeBumpSecret, network);
      feeBumpSigners[network] = feeBumpSigner.address;
    } else {
      feeBumpSigners[network] = null;
    }

    // Asset decimals cache for SEP-0041 compliance (#415)
    const rpcUrl =
      netConfig.rpcUrl ?? (network === TESTNET ? 'https://soroban-testnet.stellar.org' : undefined);
    assetCaches[network] = createAssetDecimalsCache({
      rpcUrl,
      rpcCall: netConfig.rpcUrl ? globalThis.fetch?.bind(globalThis) : undefined,
    });

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
      // The `pact` scheme is offered only where a pact contract is configured.
      const pactScheme = netConfig.pactContractId
        ? new PactStellarScheme(signersForScheme, {
            pactContracts: { [network]: netConfig.pactContractId },
            rpcConfig: netConfig.rpcUrl ? { url: netConfig.rpcUrl } : undefined,
            maxTransactionFeeStroops: netConfig.pactMaxTransactionFeeStroops,
            feeBumpSigner,
            selectSigner,
          })
        : null;
      return { scheme, pactScheme };
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
      if (next.pactScheme) facilitator.register(network, next.pactScheme);
    };
    keyManager.start();
    facilitator.register(network, schemes[network].scheme);
    if (schemes[network].pactScheme) facilitator.register(network, schemes[network].pactScheme);
  }

  return {
    facilitator,
    signers,
    feeBumpSigners,
    keyManagers,
    feeEstimators,
    schemes,
    assetCaches,
    /**
     * Stops every KeyManager this build started (#672).
     *
     * Each manager with a key source and a poll interval installed a timer in
     * `start()`; without this, shutdown closed the app and the tracer while the
     * rotation intervals kept running. KeyManager.stop() is itself a no-op for a
     * manager that never started and for a second call, so this is safe to call
     * twice and covers every network, not just the first. A manager that fails
     * to stop must not prevent the others from stopping: shutdown still has to
     * finish.
     */
    stop() {
      for (const keyManager of Object.values(keyManagers)) {
        try {
          keyManager?.stop?.();
        } catch (err) {
          console.warn(`[Facilitator] failed to stop key manager: ${err.message}`);
        }
      }
    },
  };
}

/**
 * Threshold submission call site (#412).
 *
 * The engine collects co-signatures; this is the single place that turns a
 * completed envelope into a network submission. It assembles first (throwing
 * while the threshold is unmet or the deadline passed) and only then calls
 * `submit`, so a partially-signed envelope can never reach the network.
 *
 * @param {object} engine - from createMultiSignerEngine()
 * @param {string} envelopeId
 * @param {Function} submit - async (assembledEnvelope) => result
 */
export async function submitMultiSignerEnvelope(engine, envelopeId, submit) {
  const assembled = engine.assembleEnvelope(envelopeId);
  return submit(assembled);
}

/**
 * Builds a threshold engine for one network's co-signer set.
 * Thin wrapper so the call site above never constructs engine options inline.
 */
export function buildMultiSignerEngine({ threshold, coSignerEndpoints, ...rest } = {}) {
  return createMultiSignerEngine({ threshold, coSignerEndpoints, ...rest });
}

export { TESTNET, PUBNET, loadRemoteKeys };
