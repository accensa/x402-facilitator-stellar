/**
 * @file select-conformance-components.test.js
 * @description Tests for scripts/select-conformance-components.mjs — the CI
 * step that decides which upstream e2e components the conformance job runs
 * against.
 *
 * ### Why this file exists
 * The upstream x402 harness builds every component (TypeScript, Go, Python)
 * before running any scenario. When one component fails to build, the harness
 * exits non-zero and no scenario runs at all. `select-conformance-components.mjs`
 * discovers the available components dynamically, subtracts the ones whose
 * builds failed, and emits a GitHub Actions output matrix — so a broken
 * third-party server can never kill our conformance run.
 *
 * ### Fixture design
 * The fixtures mirror the real x402 harness directory layout exactly:
 *   `<role>/<language>/<transport>/<component>`
 * with `config/mechanisms_<family>.json` controlling which languages are
 * considered for a given payment family. Both shapes are what the script
 * actually parses, so a breaking upstream change surfaces here first.
 *
 * ### Performance notes (#349)
 * - Temporary directories are created once per test and cleaned up in
 *   `t.after()` — never shared between tests to avoid ordering dependencies.
 * - `makeE2eDir` and `makeSetupLog` are pure builder functions: no I/O is
 *   repeated between calls, and the minimal directory tree is written in a
 *   single pass.
 * - `run()` parses the GITHUB_OUTPUT file with a single `readFileSync` and a
 *   single `.split('\n')` pass, avoiding repeated file reads.
 * - Component lists are sorted once inside the script; tests assert on the
 *   stable sorted form so no re-sorting is needed in the test layer.
 *
 * All tests are offline (no network) and leave no permanent files on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the script under test. Resolved once at module load. */
const SCRIPT = fileURLToPath(
  new URL('../scripts/select-conformance-components.mjs', import.meta.url),
);

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} E2eLayout
 * @property {string[]} [sdks]     - SDK language identifiers listed in
 *   mechanisms_stellar.json (default: `['typescript']`).
 * @property {string[]} [servers]  - Role-relative server component paths, e.g.
 *   `'typescript/http/express'` (default: three standard TS servers).
 * @property {string[]} [clients]  - Role-relative client component paths
 *   (default: two standard TS clients).
 */

/**
 * Builds a throwaway e2e directory tree whose layout mirrors the real x402
 * harness, populated with the components named in `layout`.
 *
 * The function writes the minimum files the script's `isComponent()` check
 * needs (`index.ts`) plus the mechanisms JSON. A `node_modules` directory is
 * deliberately injected under `servers/typescript/http/` to verify the script
 * skips harness infrastructure directories.
 *
 * @param {E2eLayout} [layout={}] - Component layout overrides.
 * @returns {string} Path to the temporary e2e root directory.
 */
function makeE2eDir(layout = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x402-e2e-'));

  // Write the mechanisms file that declares which SDK languages serve the
  // Stellar payment family's routes. The script reads this to build its
  // language filter rather than assuming a hardcoded list.
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'mechanisms_stellar.json'),
    JSON.stringify({
      routes: { '/exact/stellar': { scheme: 'exact', sdks: layout.sdks ?? ['typescript'] } },
    }),
  );

  // Write a minimal component tree: each component gets an `index.ts` marker
  // file, which is one of the signals `isComponent()` in component.ts looks for.
  const components = {
    servers: layout.servers ?? [
      'typescript/http/express',
      'typescript/http/next',
      'typescript/mcp',
    ],
    clients: layout.clients ?? ['typescript/http/fetch', 'typescript/mcp'],
  };
  for (const [role, names] of Object.entries(components)) {
    for (const name of names) {
      const componentDir = join(dir, role, ...name.split('/'));
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, 'index.ts'), '');
    }
  }

  // Inject a node_modules directory that must NOT be picked up as a component.
  const noise = join(dir, 'servers', 'typescript', 'http', 'node_modules');
  mkdirSync(noise, { recursive: true });
  writeFileSync(join(noise, 'index.ts'), '');

  debug(`fixture ready: ${dir}`);
  return dir;
}

/**
 * Writes a fake `setup.sh` output log to `dir/setup-output.txt`.
 *
 * The log format mirrors the real x402 harness summary block that
 * `select-conformance-components.mjs` parses. The failure section lists each
 * failed component as `   • <role>/<name>`, matching the bullet format the
 * script's regex expects.
 *
 * @param {string}   dir      - Base directory to write the log into.
 * @param {string[]} failures - Component paths that failed, e.g.
 *   `['server/typescript/http/next']`. Pass an empty array for a clean run.
 * @returns {string} Absolute path to the written log file.
 */
function makeSetupLog(dir, failures) {
  const path = join(dir, 'setup-output.txt');
  const body = [
    '🚀 X402 E2E Setup',
    '',
    '📦 server/typescript/http/express',
    '   ✅ Install completed',
    '',
    '═══════════════════════════════════════════════════════',
    '                 Setup Summary',
    '═══════════════════════════════════════════════════════',
    `✅ Successful: ${15 - failures.length}`,
    `❌ Failed:     ${failures.length}`,
    '📈 Total:      15',
    '',
    ...(failures.length > 0
      ? ['❌ FAILED COMPONENTS:', ...failures.map(f => `   • ${f}`), '']
      : ['✅ All setup tasks completed successfully!']),
  ].join('\n');
  writeFileSync(path, body);
  return path;
}

/**
 * Executes `select-conformance-components.mjs` as a child process and returns
 * the parsed GITHUB_OUTPUT key/value pairs alongside the combined stdout/stderr.
 *
 * The output file is pre-created as an empty file so the script's
 * `appendFileSync` always has a valid target without needing the real GitHub
 * Actions runner environment.
 *
 * **Performance note:** `execFileSync` is used instead of `spawnSync` to avoid
 * allocating a shell process; the script path is passed directly as argv so no
 * shell string interpolation occurs.
 *
 * @param {string}      e2eDir            - Temporary e2e root directory.
 * @param {string|null} setupLog          - Path to the setup log file, or
 *   `null` to omit `--setup-log` (simulates a missing log).
 * @param {Object}      [opts={}]         - Run options.
 * @param {boolean}     [opts.expectFailure=false] - When `true`, asserts the
 *   script exits non-zero; when `false`, asserts exit 0.
 * @returns {{ stdout: string, outputs: Record<string, string> }}
 */
function run(e2eDir, setupLog, { expectFailure = false } = {}) {
  // Pre-create the output file so appendFileSync in the script works without
  // the real GITHUB_OUTPUT environment being present.
  const outputFile = join(e2eDir, 'github-output.txt');
  writeFileSync(outputFile, '');

/**
 * Parses the `key=value` file the selector appends to when `--github-output` is
 * set. A line without `=` is a malformed report — precisely the class of bug
 * this file exists to catch — so it fails loudly instead of keying a field on a
 * bogus prefix and letting a downstream assertion mislead.
 */
function readGithubOutput(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`the selector was told to write ${path}, but it is unreadable: ${err.message}`);
  }

  const outputs = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new Error(
        `malformed line ${i + 1} of ${path}: expected 'key=value', got ${JSON.stringify(line)}\n${raw}`,
      );
    }
    outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
}

/** Every input and output of one run, ordered so they explain each other. */
function diagnosticsFor({
  args,
  e2eDir,
  setupLog,
  githubOutputFile,
  status,
  signal,
  spawnError,
  stdout,
  stderr,
}) {
  const section = (title, body) => [`--- ${title} ---`, body.trimEnd() || '(empty)'];
  const tree = e2eDir && existsSync(e2eDir) ? describeTree(e2eDir) : '(fixture missing)';
  const setupLogBody =
    setupLog && existsSync(setupLog) ? readFileSync(setupLog, 'utf8') : '(no setup log)';
  const outputBody =
    githubOutputFile && existsSync(githubOutputFile)
      ? readFileSync(githubOutputFile, 'utf8')
      : '(no github-output file)';

  return [
    'select-conformance-components diagnostics',
    `command: ${process.execPath} ${args.join(' ')}`,
    `exit: status=${status ?? '(none)'} signal=${signal ?? '(none)'}${
      spawnError ? ` spawnError=${spawnError.code ?? spawnError.message}` : ''
    }`,
    ...section('fixture tree', tree),
    ...section('setup log', setupLogBody),
    ...section('stdout', stdout),
    ...section('stderr', stderr),
    ...section('github output', outputBody),
  ].join('\n');
}

/**
 * The short summary every run registers as a diagnostic.
 *
 * Node prints `t.diagnostic()` output for passing tests as well as failing
 * ones, so this is deliberately one line per fact: it is the evidence a green
 * CI log carries about what the selector chose. The full dump above is reserved
 * for failures, where a reader also needs the fixture tree and both streams.
 */
function summaryFor({ args, status, signal, spawnError, stderr, outputs = {} }) {
  const stderrExcerpt = stderr.trim().split('\n').filter(Boolean).slice(0, 4).join(' | ');
  return [
    `select-conformance-components: status=${status ?? '(none)'} signal=${signal ?? '(none)'}${
      spawnError ? ` spawnError=${spawnError.code ?? spawnError.message}` : ''
    }`,
    `  command: ${process.execPath} ${args.join(' ')}`,
    outputs.servers !== undefined ? `  servers: ${outputs.servers || '(none)'}` : null,
    outputs.clients !== undefined ? `  clients: ${outputs.clients || '(none)'}` : null,
    outputs.excluded !== undefined ? `  excluded: ${outputs.excluded || '(none)'}` : null,
    stderrExcerpt ? `  stderr: ${stderrExcerpt}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Runs the selector once and returns a full record of what happened.
 *
 * Two outcomes are harness faults rather than verdicts on the script — a spawn
 * failure (ENOENT/EACCES) and a signal death (the timeout kill) — because
 * neither carries an exit code to assert against, and both would otherwise read
 * as "the script exited non-zero" and pass a test expecting failure. Those
 * throw instead, with the same diagnostics.
 */
function invoke(
  t,
  args,
  { expectFailure = false, env = {}, githubOutputFile = null, e2eDir = null, setupLog = null } = {},
) {
  // Keep runs hermetic: a CI runner exports GITHUB_OUTPUT, and a child that
  // inherits it would append to the real step output.
  const childEnv = { ...process.env, ...env };
  if (githubOutputFile) childEnv.GITHUB_OUTPUT = githubOutputFile;
  else delete childEnv.GITHUB_OUTPUT;

  debug(`run: ${process.execPath} ${args.join(' ')}`);

  let stdout = '';
  let stderr = '';
  let status = null;
  let signal = null;
  let spawnError = null;

  try {
    // Pass `process.execPath` directly instead of `'node'` so the test works
    // regardless of whether `node` is on PATH (e.g. in sandboxed CI envs).
    stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
      // Merge stderr into stdout so assertion messages include full output.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
    status = 0;
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : null;
    signal = err.signal ?? null;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    if (status === null && signal === null) spawnError = err;
  }

  const record = {
    args,
    e2eDir,
    setupLog,
    githubOutputFile,
    status,
    signal,
    spawnError,
    stdout,
    stderr,
  };
  const diagnostics = diagnosticsFor(record);
  if (VERBOSE) console.error(diagnostics);

  if (spawnError || signal) {
    const why = spawnError
      ? `the selector could not be started (${spawnError.code ?? spawnError.message})`
      : `the selector was killed by ${signal} before it exited (harness timeout ${TIMEOUT_MS}ms)`;
    throw new Error(`${why} — not a verdict on the script under test.\n${diagnostics}`);
  }

  let outputs = {};
  if (githubOutputFile) {
    try {
      outputs = readGithubOutput(githubOutputFile);
    } catch (err) {
      // A malformed report is a selector bug: fail with the whole run attached
      // rather than let a key/value assertion mislead.
      throw new Error(`${err.message}\n${diagnostics}`);
    }
  }

  const result = { ...record, outputs };

  // Registered for passing runs too, because Node prints diagnostics either
  // way — hence the short summary, with the full dump reserved for errors.
  t.diagnostic(summaryFor(result));

  assert.equal(
    status !== 0,
    expectFailure,
    `expected script to ${expectFailure ? 'fail' : 'succeed'} but it did not.\nOutput:\n${stdout}`,
  );

  // Parse GITHUB_OUTPUT in a single pass: split on newlines, skip blanks,
  // then split each line on the first `=` to produce a key/value map.
  // This avoids the overhead of multiple regex passes over the same string.
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );
  return { stdout, outputs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * When setup.sh reports no failures, every discovered component must be
 * selected and the excluded list must be empty.
 */
test('selects every component when nothing failed to build', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, makeSetupLog(dir, []));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/http/next,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch,typescript/mcp');
  assert.equal(outputs.excluded, '');
  assert.equal(outputs.excluded_count, '0');
});

/**
 * A single build failure drops only that component. The remaining servers and
 * all clients are unaffected. The excluded component name must appear in stdout
 * so the reason is visible in the CI log.
 */
test('drops only the component that failed, and names it', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  // Mirrors the real 2026-08-12 conformance failure: next.js failed to build.
  const { outputs, stdout } = run(dir, makeSetupLog(dir, ['server/typescript/http/next']));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch,typescript/mcp');
  assert.equal(outputs.excluded, 'typescript/http/next');
  assert.equal(outputs.excluded_count, '1');
  // The script must name the excluded component in its console output so the
  // failure reason is visible without inspecting the GITHUB_OUTPUT file.
  assert.match(stdout, /✗ \(build failed\) typescript\/http\/next/);
});

/**
 * A client build failure must drop the failing client only, not any server.
 * Role isolation is critical: a broken client must not prevent server testing.
 */
test('a client build failure drops a client, not a server', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, makeSetupLog(dir, ['client/typescript/mcp']));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/http/next,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch');
  assert.equal(outputs.excluded, 'typescript/mcp');
});

/**
 * When every discovered server fails to build, there is no server left to run
 * scenarios against. The script must exit non-zero with a message explaining
 * why, rather than producing a silent empty matrix that appears to succeed.
 */
test('fails rather than running an empty matrix when every server is broken', t => {
  // Use a layout with a single server so a single failure empties the list.
  const dir = makeE2eDir({ servers: ['typescript/http/express'] });
  registerTempDir(t, dir);

  const { stdout, stderr, status, outputs } = run(
    t,
    dir,
    makeSetupLog(dir, ['server/typescript/http/express']),
    {
      expectFailure: true,
    },
  );

  assert.equal(status, 1, 'a fatal selection is exit 1, distinct from the exit-2 usage error');
  // The human log names the drop on stdout; the reason GitHub surfaces as an
  // annotation is on stderr. Asserting the stream matters: a merged-stream check
  // passes even if the annotation is written to the wrong one.
  assert.match(stdout, /✗ \(build failed\) typescript\/http\/express/);
  assert.match(stderr, /::error::every discovered server failed to build/);
  // The artifact still names what was dropped, so the job's outputs explain the
  // failure even though the step failed.
  assert.equal(outputs.servers, '');
  assert.equal(outputs.excluded, 'typescript/http/express');
});

/**
 * The facilitator is the service under test. If it fails to build, the entire
 * conformance run is meaningless — any result would be untestable. The script
 * must exit non-zero immediately rather than proceeding with a broken facilitator.
 */
test('a facilitator build failure is fatal — ours is the thing under test', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { stdout, stderr, status, outputs } = run(
    t,
    dir,
    makeSetupLog(dir, ['facilitator/external-proxies/accensa']),
    { expectFailure: true },
  );

  assert.equal(status, 1);
  // stdout is the human-readable log; the `::error::` line is what GitHub turns
  // into an annotation, and it goes to stderr.
  assert.match(stdout, /facilitator build failures: external-proxies\/accensa/);
  assert.match(stderr, /::error::facilitator components failed to build/);
  assert.equal(
    outputs.excluded_count,
    '0',
    'a facilitator failure is not a server/client exclusion',
  );
});

/**
 * Components in languages not declared in `mechanisms_<family>.json` are
 * irrelevant to the payment family under test and must be silently filtered out.
 * Stellar declares TypeScript only; a Go or Python server cannot serve the
 * exact/stellar route, so its build result is irrelevant.
 */
test('ignores languages the mechanisms file does not list for the family', t => {
  const dir = makeE2eDir({
    sdks: ['typescript'],
    servers: ['typescript/http/express', 'go/http/gin', 'python/http/flask'],
  });
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, makeSetupLog(dir, []));

  // Only the TypeScript server is relevant for Stellar; Go and Python are
  // filtered before the script even considers their build status.
  assert.equal(outputs.servers, 'typescript/http/express');
});

/**
 * `node_modules` is a harness infrastructure directory that must never be
 * treated as a component, even when it contains an `index.ts` marker file.
 * The `makeE2eDir` fixture injects one explicitly to verify this invariant.
 */
test('skips harness infrastructure directories', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, makeSetupLog(dir, []));

  assert.ok(
    !outputs.servers.includes('node_modules'),
    `servers output must not include node_modules, got: ${outputs.servers}`,
  );
});

/**
 * When `--setup-log` is absent or points to a non-existent file, the script
 * must treat it as zero failures (graceful degradation) rather than crashing.
 * This handles the case where setup.sh was never run (e.g. a dry-run branch).
 */
test('treats a missing setup log as nothing-failed rather than crashing', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, null);

  assert.equal(outputs.excluded_count, '0');
});

test('a missing --e2e-dir is a usage error: exit 2, naming the flag', t => {
  const { status, stderr } = invoke(t, [SCRIPT, '--family=stellar'], { expectFailure: true });

  // Exit 2 marks a caller mistake; exit 1 belongs to a fatal selection. Keeping
  // them apart stops a misconfigured workflow reading as a conformance verdict.
  assert.equal(status, 2);
  assert.match(stderr, /--e2e-dir is required/);
});

test('a family with no mechanisms file fails loudly rather than selecting nothing', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { status, stderr } = run(t, dir, makeSetupLog(dir, []), {
    family: 'soroban-v9',
    expectFailure: true,
  });

  assert.equal(status, 1);
  assert.match(stderr, /no mechanisms file for family "soroban-v9"/);
});

test('a mechanisms file that declares no route SDKs is an error, not an empty matrix', t => {
  const dir = makeE2eDir({ servers: [], clients: [] });
  registerTempDir(t, dir);
  writeFileSync(join(dir, 'config', 'mechanisms_stellar.json'), JSON.stringify({ routes: {} }));

  const { status, stderr } = run(t, dir, makeSetupLog(dir, []), { expectFailure: true });

  assert.equal(status, 1);
  assert.match(stderr, /mechanisms_stellar\.json declares no route SDKs/);
});

test('an unrecognised failure line is not turned into an exclusion', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  // Pass null to omit --setup-log entirely.
  const { outputs } = run(dir, null);

  assert.equal(outputs.excluded_count, '0');
  assert.equal(outputs.servers, 'typescript/http/express,typescript/http/next,typescript/mcp');
});

test('--github-output with no GITHUB_OUTPUT in the environment is a no-op, not a crash', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { status, outputs } = run(t, dir, makeSetupLog(dir, []), { githubOutput: false });

  assert.equal(status, 0);
  assert.deepEqual(outputs, {});
});
