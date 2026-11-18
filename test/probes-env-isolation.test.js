/**
 * monitoring/probes.mjs — the synthetic payment command must not inherit the
 * monitor's environment (#754).
 *
 * The probe runs a configuration-supplied command from the same process that
 * holds `FACILITATOR_SECRET` and `ALICE_SECRET` (scripts/e2e.mjs spends real
 * testnet funds). Spawning it with `env: process.env` handed those keys to that
 * command, and the child's stdout/stderr are folded into
 * monitoring/out/status.json — an artifact the status-page workflow publishes.
 * A subprocess that prints its environment, or a debug log in a library it
 * loads, would have published the signing keys.
 *
 * These tests go through the real `runCommand` (a real child process, a real
 * temporary script) rather than asserting on the source, so they fail if the
 * allowlist is ever widened back to `process.env`.
 */
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childProcessEnv, runCommand, runProbes } from '../monitoring/probes.mjs';

const FACILITATOR_SECRET = 'S_TEST_FACILITATOR_SECRET_MUST_NOT_REACH_CHILD';
const ALICE_SECRET = 'S_TEST_ALICE_SECRET_MUST_NOT_REACH_CHILD';
const UNRELATED_VALUE = 'unrelated-process-value';

// Variables this file sets on the runner's own environment. Snapshotted before
// each test and restored after it, so a failure cannot leak into another test
// (or into the rest of `npm test`).
const MUTATED = [
  'PATH',
  'NODE_PATH',
  'HOME',
  'FACILITATOR_SECRET',
  'ALICE_SECRET',
  'PROBE_TEST_UNRELATED',
];

const SAFE_ENV = { PATH: '/test/bin', NODE_PATH: '/test/node-path', HOME: '/test/home' };

const dir = mkdtempSync(join(tmpdir(), 'x402-probe-env-'));
const envDumpScript = join(dir, 'dump-env.mjs');
const failingScript = join(dir, 'fail.mjs');

// Writes the child's own view of its environment to both streams, so stdout and
// stderr are each checked for a leaked secret.
writeFileSync(
  envDumpScript,
  [
    'const dump = JSON.stringify(process.env);',
    "process.stdout.write('ENV:' + dump + '\\n');",
    "process.stderr.write('ERRENV:' + dump + '\\n');",
    '',
  ].join('\n'),
);
writeFileSync(failingScript, 'process.exit(3);\n');

let snapshot;

beforeEach(() => {
  snapshot = new Map(MUTATED.map(name => [name, process.env[name]]));
});

afterEach(() => {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Sets the safe allowlisted variables plus the secrets this issue is about. */
function setRunnerEnv() {
  Object.assign(process.env, SAFE_ENV);
  process.env.FACILITATOR_SECRET = FACILITATOR_SECRET;
  process.env.ALICE_SECRET = ALICE_SECRET;
  process.env.PROBE_TEST_UNRELATED = UNRELATED_VALUE;
}

/** Parses one prefixed JSON line out of captured child output. */
function parseLine(output, prefix) {
  const line = output.split('\n').find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `child output is missing its ${prefix} line`);
  return JSON.parse(line.slice(prefix.length));
}

describe('childProcessEnv: explicit allowlist (#754)', () => {
  test('only PATH, NODE_PATH and HOME reach the child', () => {
    setRunnerEnv();

    const env = childProcessEnv();

    assert.deepEqual(env, SAFE_ENV);
    for (const name of ['FACILITATOR_SECRET', 'ALICE_SECRET', 'PROBE_TEST_UNRELATED']) {
      assert.equal(name in env, false, `${name} must not be forwarded`);
    }
  });

  test('variables that are not set are omitted rather than passed as undefined', () => {
    setRunnerEnv();
    delete process.env.HOME;
    delete process.env.NODE_PATH;

    assert.deepEqual(childProcessEnv(), { PATH: '/test/bin' });
  });

  test('an empty environment does not throw', () => {
    assert.deepEqual(childProcessEnv({}), {});
  });
});

describe('runCommand: spawned command environment (#754)', () => {
  test('the child sees the allowlisted variables and none of the secrets', async () => {
    setRunnerEnv();

    const result = await runCommand(`${process.execPath} ${envDumpScript}`, 20000);

    assert.equal(result.ok, true, `dump script must succeed: ${result.output}`);
    const stdoutEnv = parseLine(result.output, 'ENV:');
    const stderrEnv = parseLine(result.output, 'ERRENV:');

    assert.deepEqual(stdoutEnv, SAFE_ENV);
    assert.deepEqual(stderrEnv, SAFE_ENV, 'stderr must show the same isolated environment');

    for (const value of [FACILITATOR_SECRET, ALICE_SECRET, UNRELATED_VALUE]) {
      assert.equal(Object.values(stdoutEnv).includes(value), false);
      assert.equal(
        result.output.includes(value),
        false,
        'captured stdout/stderr must not carry an inherited secret',
      );
    }
  });

  test('a failing command still reports its exit code', async () => {
    setRunnerEnv();

    const result = await runCommand(`${process.execPath} ${failingScript}`, 20000);

    assert.equal(result.ok, false);
    assert.equal(result.code, 3);
  });
});

describe('runProbes: status output carries no secret (#754)', () => {
  test('the report generated from a synthetic probe run is free of secrets', async () => {
    setRunnerEnv();

    const report = await runProbes({
      config: {
        endpoint: 'https://facilitator.test',
        timeoutMs: 1000,
        probe: {
          healthz: true,
          readyz: true,
          supported: true,
          syntheticPayment: {
            enabled: true,
            command: `${process.execPath} ${envDumpScript}`,
            timeoutMs: 20000,
          },
        },
      },
      // Offline: the HTTP probes are stubbed, only the synthetic probe spawns.
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    });

    assert.equal(report.probes.syntheticPayment.ok, true);
    assert.equal(report.status, 'operational');

    // status.json is published to the public status page.
    const statusJson = JSON.stringify(report, null, 2);
    for (const value of [FACILITATOR_SECRET, ALICE_SECRET, UNRELATED_VALUE]) {
      assert.equal(statusJson.includes(value), false, 'published status must not carry a secret');
    }
  });
});
