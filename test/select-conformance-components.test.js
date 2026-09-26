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
 * Modular helpers are extracted to `test/helpers/conformance-components.js`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  createE2eFixture,
  cleanupE2eFixture,
  makeSetupLog,
  parseGithubOutput,
  executeSelector,
  assertSelectorOutputs,
} from './helpers/conformance-components.js';

/** Absolute path to the script under test. Resolved once at module load. */
const SCRIPT = fileURLToPath(
  new URL('../scripts/select-conformance-components.mjs', import.meta.url),
);

/**
 * Backwards-compatible fixture builder wrapper for existing test definitions.
 *
 * @param {import('./helpers/conformance-components.js').E2eLayout} [layout={}]
 * @returns {string}
 */
function makeE2eDir(layout = {}) {
  return createE2eFixture(layout);
}

/**
 * Backwards-compatible runner wrapper for existing test definitions.
 *
 * @param {string} e2eDir
 * @param {string|null} setupLog
 * @param {object} [opts={}]
 * @returns {{ stdout: string, outputs: Record<string, string>, failed: boolean }}
 */
function run(e2eDir, setupLog, opts = {}) {
  return executeSelector(SCRIPT, e2eDir, setupLog, opts);
}

// ---------------------------------------------------------------------------
// Conformance Component Selection Tests
// ---------------------------------------------------------------------------

describe('select-conformance-components.mjs', () => {
  /**
   * When setup.sh reports no failures, every discovered component must be
   * selected and the excluded list must be empty.
   */
  test('selects every component when nothing failed to build', t => {
    const dir = makeE2eDir();
    t.after(() => cleanupE2eFixture(dir));

    const { outputs } = run(dir, makeSetupLog(dir, []));

    assertSelectorOutputs(outputs, {
      servers: 'typescript/http/express,typescript/http/next,typescript/mcp',
      clients: 'typescript/http/fetch,typescript/mcp',
      excluded: '',
      excludedCount: 0,
    });
  });

  /**
   * A single build failure drops only that component. The remaining servers and
   * all clients are unaffected. The excluded component name must appear in stdout
   * so the reason is visible in the CI log.
   */
  test('drops only the component that failed, and names it', t => {
    const dir = makeE2eDir();
    t.after(() => cleanupE2eFixture(dir));

    // Mirrors the real 2026-08-12 conformance failure: next.js failed to build.
    const { outputs, stdout } = run(dir, makeSetupLog(dir, ['server/typescript/http/next']));

    assertSelectorOutputs(outputs, {
      servers: 'typescript/http/express,typescript/mcp',
      clients: 'typescript/http/fetch,typescript/mcp',
      excluded: 'typescript/http/next',
      excludedCount: 1,
    });
    assert.match(stdout, /✗ \(build failed\) typescript\/http\/next/);
  });

  /**
   * Multiple server build failures drop each failed server while retaining surviving servers.
   */
  test('drops multiple failing servers while keeping surviving server', t => {
    const dir = makeE2eDir();
    t.after(() => cleanupE2eFixture(dir));

    const { outputs } = run(
      dir,
      makeSetupLog(dir, ['server/typescript/http/express', 'server/typescript/http/next']),
    );

    assertSelectorOutputs(outputs, {
      servers: 'typescript/mcp',
      clients: 'typescript/http/fetch,typescript/mcp',
      excluded: 'typescript/http/express,typescript/http/next',
      excludedCount: 2,
    });
  });

  /**
   * A client build failure must drop the failing client only, not any server.
   * Role isolation is critical: a broken client must not prevent server testing.
   */
  test('a client build failure drops a client, not a server', t => {
    const dir = makeE2eDir();
    t.after(() => cleanupE2eFixture(dir));

    const { outputs } = run(dir, makeSetupLog(dir, ['client/typescript/mcp']));

    assertSelectorOutputs(outputs, {
      servers: 'typescript/http/express,typescript/http/next,typescript/mcp',
      clients: 'typescript/http/fetch',
      excluded: 'typescript/mcp',
      excludedCount: 1,
    });
  });

  /**
   * When every discovered server fails to build, there is no server left to run
   * scenarios against. The script must exit non-zero with a message explaining
   * why, rather than producing a silent empty matrix that appears to succeed.
   */
  test('fails rather than running an empty matrix when every server is broken', t => {
    // Use a layout with a single server so a single failure empties the list.
    const dir = makeE2eDir({ servers: ['typescript/http/express'] });
    t.after(() => cleanupE2eFixture(dir));

    const { stdout } = run(dir, makeSetupLog(dir, ['server/typescript/http/express']), {
      expectFailure: true,
    });

    assert.match(stdout, /every discovered server failed to build/);
  });

  /**
   * When every discovered client fails to build, there is no client left to run
   * scenarios against. The script must exit non-zero.
   */
  test('fails rather than running an empty matrix when every client is broken', t => {
    const dir = makeE2eDir({ clients: ['typescript/http/fetch'] });
    t.after(() => cleanupE2eFixture(dir));

    const { stdout } = run(dir, makeSetupLog(dir, ['client/typescript/http/fetch']), {
      expectFailure: true,
    });

    assert.match(stdout, /every discovered client failed to build/);
  });

  /**
   * The facilitator is the service under test. If it fails to build, the entire
   * conformance run is meaningless — any result would be untestable. The script
   * must exit non-zero immediately rather than proceeding with a broken facilitator.
   */
  test('a facilitator build failure is fatal — ours is the thing under test', t => {
    const dir = makeE2eDir();
    t.after(() => cleanupE2eFixture(dir));

    const { stdout } = run(dir, makeSetupLog(dir, ['facilitator/external-proxies/accensa']), {
      expectFailure: true,
    });

    assert.match(stdout, /facilitator components failed to build/);
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
    t.after(() => cleanupE2eFixture(dir));

    const { outputs } = run(dir, makeSetupLog(dir, []));

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
    t.after(() => cleanupE2eFixture(dir));

    const { outputs } = run(dir, makeSetupLog(dir, []));

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
    t.after(() => cleanupE2eFixture(dir));

    // Pass null to omit --setup-log entirely.
    const { outputs } = run(dir, null);

    assert.equal(outputs.excluded_count, '0');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for conformance helper components
// ---------------------------------------------------------------------------

describe('conformance helper utilities', () => {
  test('parseGithubOutput parses multiline key=value content', () => {
    const text = 'servers=ts/express\nclients=ts/fetch\nexcluded=\nexcluded_count=0\n';
    const parsed = parseGithubOutput(text);
    assert.deepEqual(parsed, {
      servers: 'ts/express',
      clients: 'ts/fetch',
      excluded: '',
      excluded_count: '0',
    });
  });

  test('makeSetupLog formats clean setup log without failures', t => {
    const dir = makeE2eDir();
    t.after(() => cleanupE2eFixture(dir));

    const logPath = makeSetupLog(dir, []);
    assert.ok(logPath.endsWith('setup-output.txt'));
  });

  test('assertSelectorOutputs validates expected keys and throws on mismatch', () => {
    const actual = {
      servers: 'a',
      clients: 'b',
      excluded: '',
      excluded_count: '0',
    };

    assert.doesNotThrow(() => {
      assertSelectorOutputs(actual, { servers: 'a', clients: 'b', excludedCount: 0 });
    });

    assert.throws(() => {
      assertSelectorOutputs(actual, { servers: 'other' });
    });
  });
});
