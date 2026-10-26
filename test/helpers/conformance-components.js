/**
 * @file test/helpers/conformance-components.js
 * @description Modular test fixtures and helper utilities for testing scripts/select-conformance-components.mjs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {Object} E2eLayout
 * @property {string} [family='stellar']  - Payment family name (defaults to 'stellar').
 * @property {string[]} [sdks]            - SDK language identifiers listed in mechanisms JSON (default: `['typescript']`).
 * @property {string[]} [servers]         - Role-relative server component paths (default: 3 standard TS servers).
 * @property {string[]} [clients]         - Role-relative client component paths (default: 2 standard TS clients).
 * @property {boolean} [injectNodeModules=true] - Whether to inject mock node_modules directory.
 */

/**
 * Builds a throwaway e2e directory tree whose layout mirrors the real x402
 * harness, populated with the components named in `layout`.
 *
 * @param {E2eLayout} [layout={}] - Component layout overrides.
 * @returns {string} Path to the temporary e2e root directory.
 */
export function createE2eFixture(layout = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x402-e2e-'));
  const family = layout.family ?? 'stellar';

  // Write mechanisms file declaring SDK languages for the family's routes.
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', `mechanisms_${family}.json`),
    JSON.stringify({
      routes: { [`/exact/${family}`]: { scheme: 'exact', sdks: layout.sdks ?? ['typescript'] } },
    }),
  );

  // Write minimal component tree with index.ts marker files.
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
  if (layout.injectNodeModules !== false) {
    const noise = join(dir, 'servers', 'typescript', 'http', 'node_modules');
    mkdirSync(noise, { recursive: true });
    writeFileSync(join(noise, 'index.ts'), '');
  }

  return dir;
}

/**
 * Safely removes a temporary fixture directory.
 *
 * @param {string} dir
 */
export function cleanupE2eFixture(dir) {
  if (dir && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Writes a fake setup.sh output log mirroring the x402 harness summary block.
 *
 * @param {string} dir - Base directory to write setup-output.txt into.
 * @param {string[]} failures - Component paths that failed (e.g. `['server/typescript/http/next']`).
 * @param {object} [options={}]
 * @param {number} [options.total=15]
 * @returns {string} Absolute path to the written log file.
 */
export function makeSetupLog(dir, failures = [], { total = 15 } = {}) {
  const path = join(dir, 'setup-output.txt');
  const successfulCount = Math.max(0, total - failures.length);
  const body = [
    '🚀 X402 E2E Setup',
    '',
    '📦 server/typescript/http/express',
    '   ✅ Install completed',
    '',
    '═══════════════════════════════════════════════════════',
    '                 Setup Summary',
    '═══════════════════════════════════════════════════════',
    `✅ Successful: ${successfulCount}`,
    `❌ Failed:     ${failures.length}`,
    `📈 Total:      ${total}`,
    '',
    ...(failures.length > 0
      ? ['❌ FAILED COMPONENTS:', ...failures.map(f => `   • ${f}`), '']
      : ['✅ All setup tasks completed successfully!']),
  ].join('\n');
  writeFileSync(path, body);
  return path;
}

/**
 * Parses GITHUB_OUTPUT formatted text into key-value map.
 *
 * A non-empty line without `=` is a malformed report, which is exactly the
 * class of selector bug these tests exist to catch, so it throws with the line
 * number instead of keying a field on a bogus prefix that a later assertion
 * would then misreport.
 *
 * @param {string} filePathOrContent
 * @returns {Record<string, string>}
 */
export function parseGithubOutput(filePathOrContent) {
  const content = existsSync(filePathOrContent)
    ? readFileSync(filePathOrContent, 'utf8')
    : filePathOrContent;

  const outputs = {};
  content.split('\n').forEach((line, i) => {
    if (line === '') return;
    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new Error(
        `malformed GITHUB_OUTPUT line ${i + 1}: expected 'key=value', got ${JSON.stringify(line)}`,
      );
    }
    outputs[line.slice(0, eq)] = line.slice(eq + 1);
  });
  return outputs;
}

/**
 * Executes select-conformance-components.mjs as a child process.
 *
 * @param {string} scriptPath - Absolute path to select-conformance-components.mjs.
 * @param {string} e2eDir - Temporary e2e root directory.
 * @param {string|null} setupLog - Path to setup log file or null to omit.
 * @param {object} [opts={}]
 * @param {string} [opts.family='stellar']
 * @param {boolean} [opts.expectFailure=false]
 * @param {boolean} [opts.githubOutput=true]
 * @param {Record<string, string>} [opts.env={}]
 * @param {number} [opts.timeoutMs=30000] - Kills a selector that never exits.
 * @returns {{ stdout: string, stderr: string, outputs: Record<string, string>, failed: boolean }}
 * @throws {Error} When the selector could not be started or was killed by a
 *   signal (the timeout). Neither carries an exit code, so treating them as
 *   "the script exited non-zero" would let a test that expects failure pass on
 *   a broken harness.
 */
export function executeSelector(
  scriptPath,
  e2eDir,
  setupLog,
  {
    family = 'stellar',
    expectFailure = false,
    githubOutput = true,
    env = {},
    timeoutMs = 30_000,
  } = {},
) {
  const outputFile = join(e2eDir, 'github-output.txt');
  writeFileSync(outputFile, '');

  const args = [scriptPath, `--e2e-dir=${e2eDir}`, `--family=${family}`];
  if (githubOutput) args.push('--github-output');
  if (setupLog) args.push(`--setup-log=${setupLog}`);

  let stdout = '';
  let stderr = '';
  let failed = false;
  try {
    stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputFile, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    if (typeof err.status !== 'number') {
      const why = err.signal
        ? `was killed by ${err.signal} before it exited (timeout ${timeoutMs}ms)`
        : `could not be started (${err.code ?? err.message})`;
      throw new Error(
        `the selector ${why}, which is a harness fault, not a verdict on the script.\n` +
          `command: ${process.execPath} ${args.join(' ')}\n` +
          `--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`,
      );
    }
    failed = true;
    stderr = err.stderr ?? '';
    stdout = `${err.stdout ?? ''}${stderr}`;
  }

  assert.equal(
    failed,
    expectFailure,
    `expected script to ${expectFailure ? 'fail' : 'succeed'} but it did not.\n` +
      `command: ${process.execPath} ${args.join(' ')}\nOutput:\n${stdout}`,
  );

  let outputs;
  try {
    outputs = parseGithubOutput(readFileSync(outputFile, 'utf8'));
  } catch (err) {
    throw new Error(`${err.message}\nselector output:\n${stdout}`);
  }
  return { stdout, stderr, outputs, failed };
}

/**
 * Asserts that the selector's outputs match the expected values.
 *
 * @param {Record<string, string>} actualOutputs
 * @param {object} expected
 * @param {string} [expected.servers]
 * @param {string} [expected.clients]
 * @param {string} [expected.excluded]
 * @param {string|number} [expected.excludedCount]
 */
export function assertSelectorOutputs(actualOutputs, expected = {}) {
  if (expected.servers !== undefined) {
    assert.equal(actualOutputs.servers, expected.servers, 'servers output mismatch');
  }
  if (expected.clients !== undefined) {
    assert.equal(actualOutputs.clients, expected.clients, 'clients output mismatch');
  }
  if (expected.excluded !== undefined) {
    assert.equal(actualOutputs.excluded, expected.excluded, 'excluded output mismatch');
  }
  if (expected.excludedCount !== undefined) {
    assert.equal(
      actualOutputs.excluded_count,
      String(expected.excludedCount),
      'excluded_count output mismatch',
    );
  }
}
