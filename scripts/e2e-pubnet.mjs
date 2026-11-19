#!/usr/bin/env node
/**
 * Pubnet settlement-evidence harness (#649).
 *
 * The top-level README keeps one conformance box unchecked: a real
 * `stellar:pubnet` USDC payment. Its missing input is operational, not code —
 * funded mainnet keys and a contracted RPC endpoint, which no CI secret can
 * supply. This script is the tool that turns those inputs into evidence when an
 * operator runs it, and deliberately does nothing else.
 *
 * What it proves, when credentials are present:
 *
 *   one unmodified x402 client (`x402Client` + stock `ExactStellarScheme`
 *   client) requests a resource priced in mainnet USDC, receives a 402, signs
 *   the payment authorization, retries, and this facilitator verifies and
 *   settles it on `stellar:pubnet`, sponsoring the fee.
 *
 * The report it writes is evidence, never a claim: it records the date, network,
 * asset, amount, ledger, settled transaction hash, an independent Horizon
 * verification of that hash, and the client versions used. It does not edit the
 * README or docs/CONFORMANCE.md — a human decides whether to tick the box and
 * fill the row after reading the report.
 *
 * Credential-free this names the missing variable and exits 0. In CI it refuses
 * outright, because a run needs funded mainnet keys and no workflow should ever
 * hold them. It creates, tops up and deploys nothing.
 *
 * Usage:
 *   ENABLE_PUBNET=true \
 *   FACILITATOR_SECRET_PUBNET=$(stellar keys show facilitator --network pubnet) \
 *   STELLAR_RPC_URL_PUBNET=https://... \
 *   ALICE_SECRET=$(stellar keys show alice --network pubnet) \
 *   MERCHANT_ADDRESS=G... \
 *   npm run e2e:pubnet
 *
 * Report files live under docs/conformance/. The RPC URL and every secret are
 * operator inputs; neither is ever echoed or written, and provider hosts are
 * redacted from failure output too.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactStellarScheme as ExactStellarServer } from '@x402/stellar/exact/server';
import { ExactStellarScheme as ExactStellarClient } from '@x402/stellar/exact/client';
import { createEd25519Signer, USDC_PUBNET_ADDRESS } from '@x402/stellar';
import { installRpcRetry } from '../src/rpc-retry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const NETWORK = 'stellar:pubnet';
export const SCHEME = 'exact';
export const HORIZON_URL = 'https://horizon.stellar.org';

/**
 * 1,000 stroops = 0.0001 USDC. Mainnet transfers cost real money; this is the
 * same deliberately tiny unit the testnet e2e run uses.
 */
export const PRICE_STROOPS = '1000';

/** Variables the service already documents and reads, plus the two payer/payee inputs e2e.mjs already uses. */
export const REQUIRED_ENV = [
  'ENABLE_PUBNET',
  'FACILITATOR_SECRET_PUBNET',
  'STELLAR_RPC_URL_PUBNET',
  'ALICE_SECRET',
  'MERCHANT_ADDRESS',
];

/** True when the environment looks like a CI runner. */
export function isCi(env = process.env) {
  for (const name of ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION']) {
    const value = env[name];
    if (value && !['0', 'false', 'no'].includes(String(value).toLowerCase())) return true;
  }
  return false;
}

/**
 * Names every input this harness needs that the environment does not provide.
 * `ENABLE_PUBNET` is only present when it is literally true, because the
 * service treats any other value as "pubnet is off".
 */
export function missingPubnetCredentials(env = process.env) {
  const missing = [];
  if (env.ENABLE_PUBNET !== 'true') missing.push('ENABLE_PUBNET');
  for (const name of REQUIRED_ENV.slice(1)) {
    if (!env[name]) missing.push(name);
  }
  return missing;
}

/**
 * Removes Stellar secret seeds, URLs and any known secret/URL values from text
 * before it reaches stdout or a report.
 *
 * The report is built from public identifiers only, so this is a second line of
 * defence: a future field that accidentally carries an operator input cannot
 * leak it. Provider RPC URLs commonly embed a token, so both the URL and its
 * host are removed.
 */
export function sanitizeReport(text, env = process.env) {
  let out = String(text);

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < 8) continue;
    const looksSensitive =
      /SECRET|PRIVATE_KEY|API_KEY|TOKEN|PASSWORD|MNEMONIC|SEED/i.test(name) ||
      /^S[A-Z2-7]{55}$/.test(value) ||
      /^https?:\/\//i.test(value);
    if (!looksSensitive) continue;

    out = out.split(value).join('[redacted]');
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        out = out.split(url.host).join('[redacted-host]');
        out = out.split(url.hostname).join('[redacted-host]');
      } catch {
        /* not a parsable URL; the literal replacement above still applies */
      }
    }
  }

  // Catch a secret or URL that was never in this process's environment.
  out = out.replace(/\bS[A-Z2-7]{55}\b/g, '[redacted-secret]');
  out = out.replace(/\bhttps?:\/\/[^\s)"'<>\]]+/gi, '[redacted-url]');
  return out;
}

/** Formats stroops as a 7-decimal Stellar amount without floating-point drift. */
export function formatStroops(stroops) {
  try {
    const value = BigInt(String(stroops));
    const whole = value / 10_000_000n;
    const fraction = String(value % 10_000_000n).padStart(7, '0');
    return `${whole}.${fraction}`;
  } catch {
    return String(stroops);
  }
}

/** Installed versions of the packages that actually built and sent the payment. */
export function installedVersions(root = ROOT) {
  const names = ['@x402/core', '@x402/stellar', '@x402/express', '@stellar/stellar-sdk'];
  let lock = {};
  try {
    lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  } catch {
    /* a report without versions is still better than no report, but say unknown */
  }
  const packages = lock.packages ?? {};
  const versions = {};
  for (const name of names) {
    versions[name] = packages[`node_modules/${name}`]?.version ?? 'unknown';
  }
  versions.node = process.version;
  return versions;
}

/** Dated report filename, e.g. `2026-11-19-stellar-pubnet-exact.md`. */
export function reportFilename(date = new Date()) {
  return `${date.toISOString().slice(0, 10)}-stellar-pubnet-exact.md`;
}

/**
 * Renders the evidence report. Only public identifiers are accepted; the final
 * string is sanitised anyway (see sanitizeReport).
 *
 * @param {object} evidence
 * @param {object} [env]
 * @returns {string}
 */
export function renderReport(evidence, env = process.env) {
  const {
    date,
    network = NETWORK,
    scheme = SCHEME,
    asset = USDC_PUBNET_ADDRESS,
    amount,
    amountStroops,
    transaction,
    ledger,
    horizon = {},
    versions = {},
    notes = [],
  } = evidence;

  const lines = [
    '# Stellar pubnet exact settlement evidence',
    '',
    'This report was produced by `scripts/e2e-pubnet.mjs` (#649). It records one',
    'payment made by an unmodified x402 client against this facilitator. It is',
    'evidence, not a conformance claim: the README and docs/CONFORMANCE.md are',
    'updated by a human after reading it.',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Date | ${date} |`,
    `| Network | \`${network}\` |`,
    `| Scheme | \`${scheme}\` |`,
    `| Asset | \`${asset}\` (USDC) |`,
    `| Amount | ${amount} USDC (${amountStroops} stroops) |`,
    `| Settled transaction | \`${transaction}\` |`,
    `| Ledger | ${ledger} |`,
    `| Horizon verification | \`successful=${horizon.successful}\`, \`ledger=${horizon.ledger}\`, \`created_at=${horizon.createdAt}\` |`,
    '',
    '## Independent verification',
    '',
    'The settled hash above was queried from public mainnet Horizon after the',
    'facilitator reported success. Horizon returned `successful=true` at the same',
    'ledger and time recorded here. The query is read-only and needs no key.',
    '',
    '## Client versions',
    '',
    '| Package | Version |',
    '|---|---|',
  ];

  for (const [name, version] of Object.entries(versions)) {
    lines.push(`| \`${name}\` | ${version} |`);
  }

  if (notes.length > 0) {
    lines.push('', '## Notes', '');
    for (const note of notes) lines.push(`- ${note}`);
  }

  lines.push(
    '',
    '## Redaction',
    '',
    'No secret, RPC URL or provider host is recorded in this file. Only the',
    'public hash, ledger, asset contract and package versions above are included.',
    '',
  );

  return sanitizeReport(lines.join('\n'), env);
}

/** Writes one dated report under docs/conformance/, creating the directory if needed. */
export function writeReport({ root = ROOT, date = new Date(), markdown, env = process.env }) {
  const directory = join(root, 'docs', 'conformance');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, reportFilename(date));
  writeFileSync(path, sanitizeReport(markdown, env), 'utf8');
  return path;
}

function step(n, message) {
  console.log(`\n[${n}] ${message}`);
}

function track(children, child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

/** A free localhost TCP port, so the spawned facilitator never collides with anything. */
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

/**
 * Retries a call that failed for transport reasons. Same contract as
 * scripts/e2e.mjs: connection-level failures only, never protocol failures.
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

/** Reads the settled transaction back from public mainnet Horizon. */
async function verifyOnHorizon(hash, { attempts = 12, delayMs = 2000 } = {}) {
  let last = 'never queried';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${HORIZON_URL}/transactions/${encodeURIComponent(hash)}`, {
        headers: { accept: 'application/json' },
      });
      if (res.status === 404 && attempt < attempts) {
        last = 'HTTP 404 (not yet ingested)';
      } else if (!res.ok) {
        last = `HTTP ${res.status}`;
      } else {
        const body = await res.json();
        if (body.hash !== hash) {
          throw new Error(`Horizon returned a different transaction hash`);
        }
        if (body.successful !== true) {
          throw new Error(`Horizon reports successful=${JSON.stringify(body.successful)}`);
        }
        return {
          successful: body.successful,
          ledger: body.ledger,
          createdAt: body.created_at,
        };
      }
    } catch (err) {
      if (/different transaction hash|Horizon reports/.test(err.message)) throw err;
      last = err.cause?.code ?? err.message;
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`Horizon could not verify ${hash}: ${last}`);
}

/**
 * Runs one canonical-client payment and returns the evidence to report.
 * Nothing here creates, funds or deploys an account.
 */
async function runPayment(env, { facilitatorUrl, resourcePort }) {
  const rpcUrl = env.STELLAR_RPC_URL_PUBNET;
  const merchant = env.MERCHANT_ADDRESS;

  // Client construction mirrors scripts/e2e.mjs: stock x402Client +
  // x402HTTPClient and the stock ExactStellarScheme client. The only pubnet
  // addition is the required RPC config for a non-default network.
  const payer = createEd25519Signer(env.ALICE_SECRET, NETWORK);
  const client = new x402Client()
    .register(NETWORK, new ExactStellarClient(payer, { url: rpcUrl }))
    .setSpendControls({
      allowedAssets: [{ network: NETWORK, asset: USDC_PUBNET_ADDRESS }],
    });
  const http = new x402HTTPClient(client);

  const resourceServer = new x402ResourceServer([
    new HTTPFacilitatorClient({ url: facilitatorUrl }),
  ]);
  resourceServer.register(NETWORK, new ExactStellarServer());

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    '/api/quote': {
      accepts: {
        scheme: SCHEME,
        price: { asset: USDC_PUBNET_ADDRESS, amount: PRICE_STROOPS },
        network: NETWORK,
        payTo: merchant,
      },
    },
  });

  const app = express();
  app.use(paymentMiddlewareFromHTTPServer(httpServer));
  app.get('/api/quote', (_req, res) => {
    res.json({ symbol: 'USDC', price: '0.42', asOf: new Date().toISOString() });
  });

  const server = app.listen(resourcePort);
  await new Promise(resolve => server.once('listening', resolve));

  try {
    step(1, 'Facilitator /supported');
    const supportedResponse = await fetch(`${facilitatorUrl}/supported`);
    const supported = await supportedResponse.json();
    const kind = supported.kinds?.find(k => k.network === NETWORK && k.scheme === SCHEME);
    if (!kind) throw new Error(`facilitator does not advertise ${NETWORK} / ${SCHEME}`);
    console.log(`    scheme=${kind.scheme} x402Version=${kind.x402Version}`);
    if (kind.extra?.areFeesSponsored !== true) {
      throw new Error('extra.areFeesSponsored missing or not true');
    }

    const resource = `http://127.0.0.1:${resourcePort}/api/quote`;

    step(2, `Unpaid GET ${resource} — expecting 402`);
    const unpaid = await fetch(resource);
    console.log(`    status=${unpaid.status}`);
    if (unpaid.status !== 402) throw new Error(`expected 402, got ${unpaid.status}`);

    const body = await unpaid
      .clone()
      .json()
      .catch(() => undefined);
    const paymentRequired = http.getPaymentRequiredResponse(name => unpaid.headers.get(name), body);
    const requirements = paymentRequired.accepts?.[0];
    if (!requirements) throw new Error('402 did not include payment requirements');
    if (requirements.network !== NETWORK) {
      throw new Error(`expected ${NETWORK}, got ${requirements.network}`);
    }
    if (requirements.asset !== USDC_PUBNET_ADDRESS) {
      throw new Error(`expected mainnet USDC ${USDC_PUBNET_ADDRESS}, got ${requirements.asset}`);
    }
    const amountStroops = String(
      requirements.maxAmountRequired ?? requirements.amount ?? requirements.price?.amount ?? '',
    );
    if (amountStroops !== PRICE_STROOPS) {
      throw new Error(`expected ${PRICE_STROOPS} stroops, got ${amountStroops || 'none'}`);
    }
    console.log(`    asset=${requirements.asset}`);
    console.log(`    amount=${amountStroops} stroops  payTo=${requirements.payTo}`);

    step(3, 'Client signs the auth entry (payer never sees a transaction)');
    const paymentPayload = await withTransportRetry('sign', () =>
      http.createPaymentPayload(paymentRequired),
    );
    console.log(`    payload keys: ${Object.keys(paymentPayload.payload ?? {}).join(', ')}`);

    step(4, 'Retry with X-PAYMENT — facilitator verifies, submits, sponsors the fee');
    const paid = await withTransportRetry('pay', () =>
      fetch(resource, { headers: http.encodePaymentSignatureHeader(paymentPayload) }),
    );
    console.log(`    status=${paid.status}`);
    const responseBody = await paid.text();
    const settle = http.getPaymentSettleResponse(name => paid.headers.get(name));

    if (paid.status !== 200) {
      throw new Error(
        `payment did not complete: ${settle?.errorReason ?? 'unknown'} ` +
          `${settle?.errorMessage ?? ''}`.trim(),
      );
    }
    if (!settle?.success || !settle?.transaction) {
      throw new Error(
        `settlement reported no transaction hash: ${responseBody.slice(0, 300)}`.trim(),
      );
    }
    console.log(`    success=${settle.success}`);
    console.log(`    network=${settle.network}`);
    console.log(`    tx=${settle.transaction}`);

    step(5, 'Independent Horizon verification');
    const horizon = await verifyOnHorizon(settle.transaction);
    console.log(`    successful=${horizon.successful}`);
    console.log(`    ledger=${horizon.ledger}`);
    console.log(`    created_at=${horizon.createdAt}`);

    return {
      date: horizon.createdAt ?? new Date().toISOString(),
      network: NETWORK,
      scheme: SCHEME,
      asset: USDC_PUBNET_ADDRESS,
      amount: formatStroops(amountStroops),
      amountStroops,
      transaction: settle.transaction,
      ledger: horizon.ledger,
      horizon,
      versions: installedVersions(),
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

/** Cleans up the spawned facilitator and any resource server. */
async function cleanup(children) {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Entry point. Returns a process exit code rather than exiting, so tests can
 * call it and the cleanup below always runs.
 */
export async function main({
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (isCi(env)) {
    stderr.write(
      'REFUSING: the pubnet settlement-evidence harness is operator-only and never runs in CI. ' +
        'No workflow should hold funded mainnet keys.\n',
    );
    return 2;
  }

  const missing = missingPubnetCredentials(env);
  if (missing.length > 0) {
    stdout.write(
      `SKIP: pubnet settlement evidence not run — missing ${missing.join(', ')}. ` +
        'This harness creates and funds nothing; supply funded pubnet credentials to run it.\n',
    );
    return 0;
  }

  const children = new Set();
  try {
    installRpcRetry({
      log: message => console.log(`    ${sanitizeReport(message, env)}`),
      rpcForceIpv4: env.RPC_FORCE_IPV4 !== 'false',
    });

    step(0, 'Configuration');
    console.log(`    network=stellar:pubnet  rpc=configured (redacted)`);

    const facilitatorPort = await freePort();
    const facilitatorUrl = `http://127.0.0.1:${facilitatorPort}`;
    const resourcePort = await freePort();

    step(0, 'Start the facilitator');
    const facilitator = track(
      children,
      spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
        cwd: ROOT,
        env: {
          ...env,
          // The service always requires a testnet signer at boot. This run only
          // makes a pubnet payment, so use the operator's testnet key if one is
          // present and otherwise a throwaway in-memory key — never the pubnet
          // signer, which stays isolated to its own slot.
          FACILITATOR_SECRET: env.FACILITATOR_SECRET || Keypair.random().secret(),
          ENABLE_PUBNET: 'true',
          FACILITATOR_SECRET_PUBNET: env.FACILITATOR_SECRET_PUBNET,
          STELLAR_RPC_URL_PUBNET: env.STELLAR_RPC_URL_PUBNET,
          PORT: String(facilitatorPort),
          METRICS_PORT: '',
          NODE_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    facilitator.stdout.on('data', data => {
      stdout.write(sanitizeReport(data.toString(), env));
    });
    facilitator.stderr.on('data', data => {
      stderr.write(sanitizeReport(data.toString(), env));
    });
    await waitFor(`${facilitatorUrl}/healthz`, { predicate: res => res.status === 200 });
    console.log(`    facilitator ready`);

    const evidence = await runPayment(env, { facilitatorUrl, resourcePort });
    const markdown = renderReport(evidence, env);
    const path = writeReport({ root: ROOT, date: new Date(evidence.date), markdown, env });

    console.log('\n────────────────────────────────────────────────────────────');
    console.log('PASS — unmodified canonical client settled a mainnet USDC payment');
    console.log(`  tx      ${evidence.transaction}`);
    console.log(`  ledger  ${evidence.ledger}`);
    console.log(`  report  ${relative(ROOT, path)}`);
    console.log('────────────────────────────────────────────────────────────');
    return 0;
  } catch (err) {
    const message = sanitizeReport(err instanceof Error ? err.message : String(err), env);
    stderr.write(`\nFAIL — ${message}\n`);
    if (env.VERBOSE && err instanceof Error && err.stack) {
      stderr.write(`${sanitizeReport(err.stack, env)}\n`);
    }
    return 1;
  } finally {
    await cleanup(children);
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = await main();
}
