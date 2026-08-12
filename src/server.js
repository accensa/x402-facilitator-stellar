/**
 * Process entrypoint.
 *
 * Resolves configuration, builds the facilitator and the HTTP app, and binds a
 * port. The routes themselves live in app.js, so they can be exercised in a
 * test without a listener or a real signer — this file is only the wiring that
 * a test has no use for.
 */
import { resolveConfig } from './config.js';
import { buildFacilitator } from './facilitator.js';
import { createApp } from './app.js';
import { installRpcRetry } from './rpc-retry.js';

// Must run before the scheme makes any RPC call. Retries connection-level
// failures only; see rpc-retry.js for what that deliberately excludes.
installRpcRetry({ log: msg => console.warn(`  ${msg}`) });

const config = resolveConfig();
const { facilitator, signers } = buildFacilitator(config);
const app = createApp(config, facilitator);

app.listen(config.port, () => {
  console.log(`x402 Stellar facilitator listening on :${config.port}`);
  console.log(`  networks : ${config.networks.join(', ')}`);
  for (const [network, address] of Object.entries(signers)) {
    console.log(`  signer   : ${network} -> ${address}`);
  }
  console.log(`  rpc      : ${config.rpcUrl ?? '(package default)'}`);
  console.log(`  max fee  : ${config.maxTransactionFeeStroops} stroops`);
  if (config.apiKeys.length === 0) {
    console.log('  auth     : OPEN — no API keys configured (fine for free testnet)');
  } else {
    console.log(`  auth     : ${config.apiKeys.length} API key(s) configured`);
  }
});
