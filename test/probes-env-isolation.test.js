/**
 * monitoring/probes.mjs — the synthetic payment probe's child environment (#754).
 *
 * The probe shells out to the end-to-end payment script from an external runner.
 * It used to hand the child `process.env` verbatim, so FACILITATOR_SECRET and
 * ALICE_SECRET — funded signing keys — were visible to that process, its
 * captured stdout/stderr, and anything built from the probe report. The child now
 * receives an explicit allowlist (PATH, NODE_PATH, HOME) and nothing else.
 *
 * Every case runs the real runCommand path against a throwaway Node script in a
 * temp directory: no network, no funded account, no Docker.
 */
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, runProbes } from '../monitoring/probes.mjs';

const ALLOWED = ['HOME', 'NODE_PATH', 'PATH'];
const SECRETS = {
  FACILITATOR_SECRET: 'S_TEST_FACILITATOR_SECRET_MUST_NOT_LEAK',
  ALICE_SECRET: 'S_TEST_ALICE_SECRET_MUST_NOT_LEAK',
};

const dir = mkdtempSync(join(tmpdir(), 'probes-env-isolation-'));
const dumpEnvScript = join(dir, 'dump-env.mjs');
const envOut = join(dir, 'child-env.json');

writeFileSync(
  dumpEnvScript,
  [
    "import { writeFileSync } from 'node:fs';",
    'writeFileSync(process.argv[2], JSON.stringify(process.env, null, 2));',
    // A marker proves output capture works; the leak lines prove nothing secret
    // reaches stdout/stderr when the allowlist is wrong.
    "console.log('probe-child-ran');",
    'if (process.env.FACILITATOR_SECRET) console.log(`leak: ${process.env.FACILITATOR_SECRET}`);',
    'if (process.env.ALICE_SECRET) console.error(`leak: ${process.env.ALICE_SECRET}`);',
    '',
  ].join('\n'),
);

// The runner's own environment is shared with the child by design, so every
// variable a test touches is snapshotted once and restored after each case.
const saved = {};
for (const name of [...ALLOWED, ...Object.keys(SECRETS)]) saved[name] = process.env[name];

function restoreAll() {
  for (const name of Object.keys(saved)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

/** Config that runs only the synthetic probe, so nothing reaches the network. */
function probeConfig(command) {
  return {
    endpoint: 'https://facilitator.test',
    timeoutMs: 1000,
    probe: {
      healthz: false,
      readyz: false,
      supported: false,
      syntheticPayment: { enabled: true, command, timeoutMs: 15000 },
    },
  };
}

const noFetch = async () => {
  throw new Error('a synthetic-probe test must not touch the network');
};

/** Runs the uploaded command through runProbes -> the real runCommand. */
function probeWith(command) {
  return runProbes({ config: probeConfig(command), fetchImpl: noFetch, env: {} });
}

function childEnvironment() {
  return JSON.parse(readFileSync(envOut, 'utf8'));
}

beforeEach(() => {
  process.env.NODE_PATH = '/probe-node-path';
  process.env.HOME = '/probe-home';
  for (const [name, value] of Object.entries(SECRETS)) process.env[name] = value;
});

afterEach(() => {
  restoreAll();
  rmSync(envOut, { force: true });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runCommand: child environment allowlist', () => {
  test('the child receives only PATH, NODE_PATH and HOME', async () => {
    const report = await probeWith(`${process.execPath} ${dumpEnvScript} ${envOut}`);

    assert.equal(
      report.probes.syntheticPayment.ok,
      true,
      'the controlled command must run through the synthetic probe',
    );
    const env = childEnvironment();
    assert.deepEqual(
      Object.keys(env).sort(),
      ALLOWED,
      'the child environment must be built from the allowlist, never spread from process.env',
    );
    assert.equal(env.PATH, process.env.PATH, 'PATH is required to resolve the command');
    assert.equal(env.NODE_PATH, '/probe-node-path');
    assert.equal(env.HOME, '/probe-home');
  });

  test('FACILITATOR_SECRET and ALICE_SECRET never reach the child', async () => {
    await probeWith(`${process.execPath} ${dumpEnvScript} ${envOut}`);

    const env = childEnvironment();
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.equal(env[name], undefined, `${name} must not be inherited by the synthetic command`);
      assert.equal(
        JSON.stringify(env).includes(value),
        false,
        `${name}'s value must not appear anywhere in the child environment`,
      );
    }
  });

  test('captured output and the probe report never expose the secrets', async () => {
    const result = await runCommand(`${process.execPath} ${dumpEnvScript} ${envOut}`, 15000);

    assert.equal(result.ok, true);
    assert.ok(
      result.output.includes('probe-child-ran'),
      'the marker must be captured — otherwise the absence assertions below prove nothing',
    );
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.equal(
        result.output.includes(value),
        false,
        `${name} must not appear in the captured stdout/stderr`,
      );
    }

    // The report is what the status page publishes: it carries counters only, so
    // neither the captured output nor a secret can ride along.
    const report = await probeWith(`${process.execPath} ${dumpEnvScript} ${envOut}`);
    assert.deepEqual(
      Object.keys(report.probes.syntheticPayment).sort(),
      ['code', 'latencyMs', 'level', 'ok'],
      'the published status must not carry the command output',
    );
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.equal(
        JSON.stringify(report).includes(value),
        false,
        `${name} must not appear in the published probe report`,
      );
    }
  });

  test('a missing optional variable is absent, not the string "undefined"', async () => {
    delete process.env.NODE_PATH;

    const report = await probeWith(`${process.execPath} ${dumpEnvScript} ${envOut}`);

    assert.equal(report.probes.syntheticPayment.ok, true, 'the command must still run');
    const env = childEnvironment();
    assert.equal('NODE_PATH' in env, false, 'an unset variable must be omitted, not stringified');
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
  });
});

describe('runCommand: existing execution semantics are preserved', () => {
  test('a non-zero exit is reported as a failed command with its code', async () => {
    const result = await runCommand(`${process.execPath} -e process.exit(3)`, 15000);

    assert.equal(result.ok, false);
    assert.equal(result.code, 3);
  });

  test('a command that overruns its timeout is still killed', async () => {
    const result = await runCommand(`${process.execPath} -e setTimeout(()=>{},10000)`, 100);

    assert.equal(result.ok, false);
    assert.notEqual(result.code, 0);
  });
});
