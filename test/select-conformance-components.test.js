/**
 * Covers scripts/select-conformance-components.mjs — the step that decides
 * which upstream e2e components the conformance job runs against.
 *
 * The fixtures below mirror the real x402 harness layout
 * (role/language/transport/component) and the exact shape of setup.sh's
 * failure report, because both are what the script parses. If upstream changes
 * either, these tests are where it should surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../scripts/select-conformance-components.mjs', import.meta.url),
);

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

function run(e2eDir, setupLog, { expectFailure = false } = {}) {
  const outputFile = join(e2eDir, 'github-output.txt');
  writeFileSync(outputFile, '');

  const args = [SCRIPT, `--e2e-dir=${e2eDir}`, '--family=stellar', '--github-output'];
  if (setupLog) args.push(`--setup-log=${setupLog}`);

  let stdout = '';
  let failed = false;
  try {
    stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    failed = true;
    stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  assert.equal(
    failed,
    expectFailure,
    `expected ${expectFailure ? 'failure' : 'success'}:\n${stdout}`,
  );

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

test('selects every component when nothing failed to build', t => {
  const dir = makeE2eDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { outputs } = run(dir, makeSetupLog(dir, []));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/http/next,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch,typescript/mcp');
  assert.equal(outputs.excluded, '');
  assert.equal(outputs.excluded_count, '0');
});

test('drops only the component that failed, and names it', t => {
  const dir = makeE2eDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // The real 2026-08-12 failure.
  const { outputs, stdout } = run(dir, makeSetupLog(dir, ['server/typescript/http/next']));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch,typescript/mcp');
  assert.equal(outputs.excluded, 'typescript/http/next');
  assert.equal(outputs.excluded_count, '1');
  assert.match(stdout, /✗ \(build failed\) typescript\/http\/next/);
});

test('a client build failure drops a client, not a server', t => {
  const dir = makeE2eDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { outputs } = run(dir, makeSetupLog(dir, ['client/typescript/mcp']));

  assert.equal(outputs.servers, 'typescript/http/express,typescript/http/next,typescript/mcp');
  assert.equal(outputs.clients, 'typescript/http/fetch');
  assert.equal(outputs.excluded, 'typescript/mcp');
});

test('fails rather than running an empty matrix when every server is broken', t => {
  const dir = makeE2eDir({ servers: ['typescript/http/express'] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { stdout } = run(dir, makeSetupLog(dir, ['server/typescript/http/express']), {
    expectFailure: true,
  });

  assert.match(stdout, /every discovered server failed to build/);
});

test('a facilitator build failure is fatal — ours is the thing under test', t => {
  const dir = makeE2eDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { stdout } = run(dir, makeSetupLog(dir, ['facilitator/external-proxies/accensa']), {
    expectFailure: true,
  });

  assert.match(stdout, /facilitator components failed to build/);
});

test('ignores languages the mechanisms file does not list for the family', t => {
  const dir = makeE2eDir({
    sdks: ['typescript'],
    servers: ['typescript/http/express', 'go/http/gin', 'python/http/flask'],
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { outputs } = run(dir, makeSetupLog(dir, []));

  // Stellar declares typescript SDKs only; a Go server cannot serve the route,
  // so failing to build it is irrelevant to this run.
  assert.equal(outputs.servers, 'typescript/http/express');
});

test('skips harness infrastructure directories', t => {
  const dir = makeE2eDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { outputs } = run(dir, makeSetupLog(dir, []));

  assert.ok(!outputs.servers.includes('node_modules'));
});

test('treats a missing setup log as nothing-failed rather than crashing', t => {
  const dir = makeE2eDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { outputs } = run(dir, null);

  assert.equal(outputs.excluded_count, '0');
});
