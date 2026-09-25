/**
 * Covers scripts/select-conformance-components.mjs — the step that decides
 * which upstream e2e components the conformance job runs against.
 *
 * The fixtures below mirror the real x402 harness layout
 * (role/language/transport/component) and the exact shape of setup.sh's
 * failure report, because both are what the script parses. If upstream changes
 * either, these tests are where it should surface.
 *
 * A failure here has two very different causes — the selector picking the
 * wrong matrix, or the child process never running at all — and the bare
 * `execFileSync` error does not distinguish them. So every run captures the
 * exit status, the terminating signal, stdout, stderr and the child's own
 * GitHub-output file. Each run registers a short summary with `t.diagnostic()`
 * — Node prints that for passing tests as well, so it stays brief and is the
 * evidence a green CI log carries — while any failure carries the full dump:
 * fixture tree, setup log, both streams, output file. `X402_TEST_DEBUG=1` prints
 * that dump live too; `X402_TEST_KEEP=1` keeps a fixture for inspection instead
 * of deleting it.
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

const SCRIPT = fileURLToPath(
  new URL('../scripts/select-conformance-components.mjs', import.meta.url),
);

/**
 * A hard stop, so a selector that wedges — a blocking read, an accidental
 * `--watch` — fails the test instead of stalling the suite. A real run takes
 * well under a second, so this only ever fires on a genuine hang.
 */
const TIMEOUT_MS = 20_000;

/** Opt-in live logging: X402_TEST_DEBUG=1. Silence is the default. */
const VERBOSE = /^(1|true|yes)$/i.test(process.env.X402_TEST_DEBUG ?? '');

/** Opt-in fixture retention for post-mortem inspection: X402_TEST_KEEP=1. */
const KEEP_FIXTURES = /^(1|true|yes)$/i.test(process.env.X402_TEST_KEEP ?? '');

function debug(...parts) {
  if (VERBOSE) console.error('[select-conformance]', ...parts);
}

/** Removes a fixture at the end of the test — but never turns green into red. */
function registerTempDir(t, dir) {
  t.after(() => {
    if (KEEP_FIXTURES) {
      debug(`keeping fixture for inspection: ${dir}`);
      return;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // A cleanup failure must not mask the test's real result, and must not be
      // swallowed either: name the path so it can be removed by hand.
      console.error(
        `[select-conformance] warning: could not remove fixture ${dir}: ${err.message}`,
      );
    }
  });
}

/** Builds a throwaway e2e tree with the components named in `layout`. */
function makeE2eDir(layout = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x402-e2e-'));

  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'mechanisms_stellar.json'),
    JSON.stringify({
      routes: { '/exact/stellar': { scheme: 'exact', sdks: layout.sdks ?? ['typescript'] } },
    }),
  );

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
      // index.ts is one of the markers component.ts treats as "this is a component".
      writeFileSync(join(componentDir, 'index.ts'), '');
    }
  }

  // Directories the harness skips must not be picked up as components.
  const noise = join(dir, 'servers', 'typescript', 'http', 'node_modules');
  mkdirSync(noise, { recursive: true });
  writeFileSync(join(noise, 'index.ts'), '');

  debug(`fixture ready: ${dir}`);
  return dir;
}

/** Writes a setup.sh log whose failure section lists `failures`. */
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
 * An indented listing of a fixture tree, so a discovery mismatch can be
 * explained without re-running the test. Read errors are reported inline rather
 * than thrown: diagnostics must never be the reason a test blows up.
 */
function describeTree(root, prefix = '') {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (err) {
    return [`${prefix}(unreadable: ${err.message})`].join('\n');
  }

  const lines = [];
  for (const entry of entries) {
    lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory()) {
      lines.push(describeTree(join(root, entry.name), `${prefix}  `));
    }
  }
  return lines.join('\n') || `${prefix}(empty)`;
}

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
    stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: childEnv,
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
    `expected the selector to ${expectFailure ? 'exit non-zero' : 'exit 0'}; it exited ${status}.\n${diagnostics}`,
  );

  debug(`selected servers: ${outputs.servers ?? '(no github output)'}`);

  return result;
}

/**
 * The common case: run the selector against a fixture tree and its setup log.
 * `githubOutput: false` simulates a run with no GITHUB_OUTPUT in the
 * environment, which is what a developer's machine looks like.
 */
function run(
  t,
  e2eDir,
  setupLog,
  { expectFailure = false, family = 'stellar', githubOutput = true } = {},
) {
  assert.ok(e2eDir && existsSync(e2eDir), `fixture e2e dir is missing: ${e2eDir}`);

  const githubOutputFile = githubOutput ? join(e2eDir, 'github-output.txt') : null;
  if (githubOutputFile) writeFileSync(githubOutputFile, '');

  const args = [SCRIPT, `--e2e-dir=${e2eDir}`, `--family=${family}`, '--github-output'];
  if (setupLog) args.push(`--setup-log=${setupLog}`);

  return invoke(t, args, { expectFailure, githubOutputFile, e2eDir, setupLog });
}

test('selects every component when nothing failed to build', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, makeSetupLog(dir, []));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/http/next,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch,typescript/mcp');
  assert.equal(outputs.excluded, '');
  assert.equal(outputs.excluded_count, '0');
});

test('drops only the component that failed, and names it', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  // The real 2026-08-12 failure.
  const { outputs, stdout } = run(t, dir, makeSetupLog(dir, ['server/typescript/http/next']));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch,typescript/mcp');
  assert.equal(outputs.excluded, 'typescript/http/next');
  assert.equal(outputs.excluded_count, '1');
  assert.match(stdout, /✗ \(build failed\) typescript\/http\/next/);
});

test('a client build failure drops a client, not a server', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, makeSetupLog(dir, ['client/typescript/mcp']));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/http/next,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch');
  assert.equal(outputs.excluded, 'typescript/mcp');
});

test('fails rather than running an empty matrix when every server is broken', t => {
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

test('ignores languages the mechanisms file does not list for the family', t => {
  const dir = makeE2eDir({
    sdks: ['typescript'],
    servers: ['typescript/http/express', 'go/http/gin', 'python/http/flask'],
  });
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, makeSetupLog(dir, []));

  // Stellar declares typescript SDKs only; a Go server cannot serve the route,
  // so failing to build it is irrelevant to this run.
  assert.equal(outputs.servers, 'typescript/http/express');
});

test('skips harness infrastructure directories', t => {
  const dir = makeE2eDir();
  registerTempDir(t, dir);

  const { outputs } = run(t, dir, makeSetupLog(dir, []));

  assert.ok(!outputs.servers.includes('node_modules'));
});

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

  // If setup.sh ever grows another top-level role, an unmatched bullet must end
  // the list rather than have its prefix mistaken for a component name.
  const { outputs } = run(t, dir, makeSetupLog(dir, ['infra/telemetry-collector']));

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
