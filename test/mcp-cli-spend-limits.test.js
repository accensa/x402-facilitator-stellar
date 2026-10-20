/**
 * The agent's spend caps are money-safety controls (#497).
 *
 * `MAX_FEE_PER_CALL_STROOPS` and `MAX_SESSION_SPEND_STROOPS` used to be
 * converted at module scope, so `MAX_FEE_PER_CALL_STROOPS=1,000` — the shape an
 * operator gets by copying a number out of a doc, and the shape `.env.example`
 * invites — threw a bare SyntaxError while the CLI module was still loading,
 * before argument parsing or any of the CLI's own error paths ran. x402-mcp
 * died with a stack trace that never named the variable.
 *
 * These tests spawn the real CLI and pin the guard that replaced it: a
 * malformed cap names its variable, names the unit, exits non-zero and prints
 * no stack trace. A well-formed cap — including 0, a legitimate "spend
 * nothing" limit — still starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../src/mcp/cli.js', import.meta.url));

/** A copy of the current environment with `overrides` applied (undefined unsets). */
function envWith(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/** Runs the CLI to completion with the given spend-cap environment. */
function runCli(overrides = {}) {
  return spawnSync(process.execPath, [CLI, '--help'], {
    cwd: ROOT,
    env: envWith(overrides),
    encoding: 'utf8',
  });
}

const CAP_VARS = ['MAX_FEE_PER_CALL_STROOPS', 'MAX_SESSION_SPEND_STROOPS'];
const MALFORMED = ['1,000', 'abc', '-5'];

for (const name of CAP_VARS) {
  for (const value of MALFORMED) {
    test(`${name}=${JSON.stringify(value)} exits non-zero naming ${name}, with no stack trace`, () => {
      const { status, stderr } = runCli({ [name]: value });

      assert.notEqual(status, 0, `${name}=${value} must stop the CLI, not fall back to a default`);
      assert.match(stderr, new RegExp(name), `the failure must name ${name}`);
      assert.match(stderr, /stroops/, 'the failure must name the expected unit (stroops)');
      assert.doesNotMatch(stderr, /\n\s+at /, `no stack trace may be printed for ${name}`);
    });
  }
}

test('well-formed caps are accepted, including 0', () => {
  for (const name of CAP_VARS) {
    for (const value of ['0', '1000']) {
      const { status, stderr } = runCli({ [name]: value });
      assert.equal(status, 0, `${name}=${value} must be accepted (stderr: ${stderr})`);
    }
  }
});

test('unset caps still default to 1000 and 10000 stroops', () => {
  // Read the resolved module-scope constants in a child process: module scope
  // exits the process on a bad cap, so this cannot be asserted in-process
  // without also starting the server. The CLI only starts when it is the main
  // module, so importing it here resolves the constants and exits.
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(pathToFileURL(CLI).href)}).then(m => ` +
        `console.log(m.MAX_FEE_PER_CALL_STROOPS.toString(), m.MAX_SESSION_SPEND_STROOPS.toString()))`,
    ],
    {
      cwd: ROOT,
      env: envWith({
        MAX_FEE_PER_CALL_STROOPS: undefined,
        MAX_SESSION_SPEND_STROOPS: undefined,
      }),
      encoding: 'utf8',
    },
  );

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), '1000 10000');
});
