#!/usr/bin/env node
/**
 * Examples smoke test (issue #190).
 *
 * The previous CI gate started each example with `&`, slept, and killed the
 * job — so a broken example still produced a green check. This script does
 * what that ritual claimed to: it starts each example, waits until it is
 * actually serving, asserts something real about its behaviour, and lets the
 * assertion decide the exit status.
 *
 *   examples/http-seller  — request the paid route, expect HTTP 402 with a
 *                           well-formed PAYMENT-REQUIRED challenge (the
 *                           example's whole point).
 *   examples/mcp-agent    — speak MCP over stdio to the server the example
 *                           drives (src/mcp/cli.js): initialize, then
 *                           tools/list, and require a non-empty tool list.
 *
 * Everything is hermetic: the seller is given a MERCHANT_SECRET so it never
 * calls friendbot, and the facilitator is given a freshly generated testnet
 * key so it can boot offline. No backgrounded shells, no fixed sleeps, no
 * kill %1 — children are spawned, polled, asserted on and shut down here.
 *
 * Usage:
 *   node scripts/smoke-examples.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELLER_DIR = join(ROOT, 'examples', 'http-seller');

const children = new Set();

/** Registers a child for cleanup on any exit path. */
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

/** A free localhost TCP port, so the two servers never collide with anything. */
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
 * Polls `url` until `predicate(response)` is true or the timeout elapses.
 * Connection errors are treated as "not listening yet", so this doubles as
 * the readiness wait: the process must actually serve before we assert.
 */
async function waitFor(url, { timeoutMs = 30_000, intervalMs = 250, predicate }) {
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

/**
 * examples/http-seller: start a real facilitator and the seller, then assert
 * the paid route answers 402 with a well-formed x402 challenge.
 */
async function assertHttpSeller() {
  const facilitatorPort = await freePort();
  const sellerPort = await freePort();

  const facilitator = track(
    spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        // A fresh testnet key: config only validates its shape, so the
        // facilitator boots offline — no friendbot, no funded account.
        FACILITATOR_SECRET: Keypair.random().secret(),
        PORT: String(facilitatorPort),
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  facilitator.stdout.on('data', d => process.stdout.write(`[facilitator] ${d}`));
  facilitator.stderr.on('data', d => process.stderr.write(`[facilitator] ${d}`));

  await waitFor(`http://127.0.0.1:${facilitatorPort}/healthz`, {
    predicate: res => res.status === 200,
  });

  const seller = track(
    spawn(process.execPath, [join(SELLER_DIR, 'index.js')], {
      cwd: SELLER_DIR,
      env: {
        ...process.env,
        // A configured merchant skips friendbot entirely, so the example
        // boots without touching the network.
        MERCHANT_SECRET: Keypair.random().secret(),
        FACILITATOR_URL: `http://127.0.0.1:${facilitatorPort}`,
        PORT: String(sellerPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  seller.stdout.on('data', d => process.stdout.write(`[seller] ${d}`));
  seller.stderr.on('data', d => process.stderr.write(`[seller] ${d}`));

  // The middleware syncs with the facilitator lazily; a 500 on the first
  // request while initialize() retries is not a pass, so poll for the 402.
  const res = await waitFor(`http://127.0.0.1:${sellerPort}/api/joke`, {
    predicate: r => r.status === 402,
  });
  if (res.status !== 402) {
    throw new Error(`expected 402 from the paid route, got ${res.status}`);
  }

  const header = res.headers.get('payment-required');
  if (!header) {
    throw new Error('the 402 response carries no PAYMENT-REQUIRED header');
  }
  let challenge;
  try {
    challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`PAYMENT-REQUIRED header is not well-formed base64 JSON: ${err.message}`);
  }
  const option = challenge?.accepts?.[0];
  if (!option) {
    throw new Error('PAYMENT-REQUIRED challenge declares no payment options');
  }
  for (const [field, expected] of [
    ['scheme', 'exact'],
    ['network', 'stellar:testnet'],
  ]) {
    if (option[field] !== expected) {
      throw new Error(`challenge accepts[0].${field} = ${option[field]}, expected ${expected}`);
    }
  }
  // x402 v2 flattens the price onto the option: amount + asset (the SAC id).
  for (const field of ['amount', 'asset', 'payTo']) {
    if (!option[field]) {
      throw new Error(`challenge accepts[0] carries no ${field}`);
    }
  }

  await cleanup();
}

/** Minimal JSON-RPC client over a child's stdio. */
function rpcClient(child) {
  const rl = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();

  rl.on('line', line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a response line
    }
    if (msg.id === undefined || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
    else resolve(msg.result);
  });

  child.on('exit', code => {
    for (const { reject } of pending.values())
      reject(new Error(`MCP server exited with code ${code}`));
    pending.clear();
  });

  return (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to ${method} within 15s`));
      }, 15_000);
      pending.set(id, {
        resolve: result => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
}

/**
 * examples/mcp-agent: the example drives src/mcp/cli.js over stdio, so the
 * smoke test speaks to that same server — initialize, then tools/list — and
 * requires the tool list to be non-empty.
 */
async function assertMcpAgent() {
  const cli = track(
    spawn(process.execPath, [join(ROOT, 'src', 'mcp', 'cli.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        // The example always configures a payer key; a fresh one exercises
        // the signer-init path without touching the network.
        AGENT_PAYER_SECRET_KEY: Keypair.random().secret(),
        NETWORK: 'stellar:testnet',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  cli.stderr.on('data', d => process.stderr.write(`[mcp] ${d}`));

  const send = rpcClient(cli);

  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'examples-smoke', version: '0.0.0' },
  });
  if (init.serverInfo?.name !== 'x402-facilitator-stellar-mcp') {
    throw new Error(
      `initialize answered with unexpected serverInfo: ${JSON.stringify(init.serverInfo)}`,
    );
  }

  const listed = await send('tools/list', {});
  const names = (listed.tools ?? []).map(tool => tool.name);
  if (names.length === 0) {
    throw new Error('tools/list returned an empty tool list');
  }
  for (const expected of ['search_resources', 'get_resource', 'call_paid_resource']) {
    if (!names.includes(expected)) {
      throw new Error(`tools/list is missing ${expected} (got: ${names.join(', ')})`);
    }
  }

  await cleanup();
}

let failed = false;
try {
  await assertHttpSeller();
  console.log(
    '✓ http-seller: paid route returns 402 with a well-formed PAYMENT-REQUIRED challenge',
  );
  await assertMcpAgent();
  console.log(
    '✓ mcp-agent: MCP server answers initialize and tools/list with a non-empty tool list',
  );
} catch (err) {
  failed = true;
  console.error(`✘ examples smoke test failed: ${err.message}`);
} finally {
  await cleanup();
}

process.exit(failed ? 1 : 0);
