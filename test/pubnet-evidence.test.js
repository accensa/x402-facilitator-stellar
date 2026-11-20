/**
 * Offline guards for the pubnet settlement-evidence harness (#649).
 *
 * The harness needs funded mainnet keys, so the payment path itself cannot run
 * here. What can be pinned offline is the part a future edit is most likely to
 * get wrong: a credential-free run must be a clean skip (not a crash and not a
 * partial report), CI must refuse even when credentials are present, and the
 * report renderer must never carry a Stellar secret or a provider RPC URL.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';
import { USDC_PUBNET_ADDRESS } from '@x402/stellar';
import {
  formatStroops,
  missingPubnetCredentials,
  renderReport,
  reportFilename,
  sanitizeReport,
  writeReport,
} from '../scripts/e2e-pubnet.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/e2e-pubnet.mjs', import.meta.url));

const REQUIRED = [
  'ENABLE_PUBNET',
  'FACILITATOR_SECRET_PUBNET',
  'STELLAR_RPC_URL_PUBNET',
  'ALICE_SECRET',
  'MERCHANT_ADDRESS',
];

/** A child environment with CI markers and pubnet inputs removed. */
function cleanEnv() {
  const env = { ...process.env };
  for (const name of [...REQUIRED, 'CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION']) {
    delete env[name];
  }
  return env;
}

function runHarness(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

/** Values that look like credentials without ever being usable ones. */
function fakeCredentials() {
  return {
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: Keypair.random().secret(),
    STELLAR_RPC_URL_PUBNET: 'https://rpc.provider.invalid/v1/token-value',
    ALICE_SECRET: Keypair.random().secret(),
    MERCHANT_ADDRESS: Keypair.random().publicKey(),
  };
}

describe('pubnet evidence harness (#649): credential-free behaviour', () => {
  test('missing inputs are named and the run skips with exit 0, no stack, no report', () => {
    const env = cleanEnv();
    const result = runHarness(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^SKIP: pubnet settlement evidence not run/m);
    for (const name of REQUIRED) {
      assert.match(result.stdout, new RegExp(name), `skip must name ${name}`);
    }
    assert.doesNotMatch(result.stdout, /^\s+at .+:\d+:\d+/m, 'skip must not print a stack trace');
    assert.doesNotMatch(result.stderr, /^\s+at .+:\d+:\d+/m, 'skip must not print a stack trace');
    assert.equal(result.signal, null, 'the harness must exit cleanly, not be killed');
  });

  test('a single missing variable is named exactly', () => {
    const env = {
      ...cleanEnv(),
      ...fakeCredentials(),
    };
    delete env.FACILITATOR_SECRET_PUBNET;

    const result = runHarness(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FACILITATOR_SECRET_PUBNET/);
    assert.doesNotMatch(result.stdout, /ALICE_SECRET|MERCHANT_ADDRESS|STELLAR_RPC_URL_PUBNET/);
    assert.deepEqual(missingPubnetCredentials(env), ['FACILITATOR_SECRET_PUBNET']);
  });
});

describe('pubnet evidence harness (#649): CI refusal', () => {
  test('CI refuses outright even with every credential present', () => {
    const env = {
      ...cleanEnv(),
      ...fakeCredentials(),
      CI: 'true',
    };

    const result = runHarness(env);

    assert.notEqual(result.status, 0, 'CI must never run a funded mainnet harness');
    assert.match(result.stderr, /REFUSING/);
    assert.match(result.stderr, /never runs in CI/);
    assert.doesNotMatch(result.stdout, /PASS/);
    assert.doesNotMatch(result.stderr, new RegExp(env.ALICE_SECRET));
    assert.doesNotMatch(result.stderr, /rpc\.provider\.invalid/);
  });
});

describe('pubnet evidence harness (#649): report redaction and naming', () => {
  test('a report can never contain an S… secret, RPC URL or provider host', () => {
    const secret = Keypair.random().secret();
    const rpcUrl = 'https://rpc.provider.invalid/v1/token-value';
    const env = { ...process.env, ALICE_SECRET: secret, STELLAR_RPC_URL_PUBNET: rpcUrl };

    const markdown = renderReport(
      {
        date: '2026-11-19T12:00:00Z',
        network: 'stellar:pubnet',
        scheme: 'exact',
        asset: USDC_PUBNET_ADDRESS,
        amount: formatStroops('1000'),
        amountStroops: '1000',
        transaction: 'a'.repeat(64),
        ledger: 123456,
        horizon: {
          successful: true,
          ledger: 123456,
          createdAt: '2026-11-19T12:00:00Z',
        },
        versions: { '@x402/core': '2.23.0', '@x402/stellar': '2.23.0', node: 'v22.0.0' },
        notes: [`secret ${secret}`, `endpoint ${rpcUrl}`],
      },
      env,
    );

    assert.equal(formatStroops('1000'), '0.0001000');
    assert.ok(markdown.includes('a'.repeat(64)));
    assert.ok(markdown.includes(USDC_PUBNET_ADDRESS));
    assert.ok(!markdown.includes(secret), 'a Stellar secret must never reach the report');
    assert.ok(!markdown.includes(rpcUrl), 'the RPC URL must never reach the report');
    assert.ok(!markdown.includes('rpc.provider.invalid'), 'the provider host must never reach it');
    assert.doesNotMatch(markdown, /https?:\/\//, 'the report records public identifiers only');
    assert.match(markdown, /\[redacted/);
    assert.equal(sanitizeReport(secret, env), '[redacted]');
  });

  test('the report is one dated file under docs/conformance/', t => {
    const root = mkdtempSync(join(tmpdir(), 'x402-pubnet-report-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const date = new Date('2026-11-19T12:00:00Z');
    assert.equal(reportFilename(date), '2026-11-19-stellar-pubnet-exact.md');

    const markdown = renderReport(
      {
        date: date.toISOString(),
        amount: '0.0001000',
        amountStroops: '1000',
        transaction: 'b'.repeat(64),
        ledger: 42,
        horizon: { successful: true, ledger: 42, createdAt: date.toISOString() },
        versions: { '@x402/core': '2.23.0' },
      },
      {},
    );

    const path = writeReport({ root, date, markdown, env: {} });
    assert.equal(
      relative(root, path),
      join('docs', 'conformance', '2026-11-19-stellar-pubnet-exact.md'),
    );
    assert.ok(readFileSync(path, 'utf8').includes('b'.repeat(64)));
  });
});
