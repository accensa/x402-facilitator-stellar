import { installRpcRetry } from './src/rpc-retry.js';
import { createMetrics } from './src/metrics.js';

const metrics = createMetrics();
installRpcRetry({
  attempts: 3,
  baseDelayMs: 10,
  log: msg => console.log(msg),
  onRetry: ({ code }) => metrics.incRpcRetry({ code }),
});

async function run() {
  try {
    await fetch('http://localhost:59999'); // connection refused
  } catch {
    // Expected: the script intentionally targets a dead endpoint to exercise
    // the RPC retry path, so the fetch failure itself needs no handling.
  }
  console.log(metrics.render());
}
run();
