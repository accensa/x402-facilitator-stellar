/**
 * Covers scripts/check-env-doc.mjs — the guard that keeps .env.example in
 * sync with the variables actually read in src/ (issue #144), in both
 * directions: a variable read in src/ must be documented there, and a
 * variable documented there must be read by the code or excused by the
 * allowlist (issue #504).
 *
 * The interesting failures are the two the script exists to catch: a variable
 * read in src/ with no entry in .env.example, and a variable documented in
 * .env.example that no code reads. The real repo must pass; a fixture with
 * either drift must fail and name the offending variable. The third failure
 * is the allowlist's own expiry: an entry must not outlive the code it
 * excuses, or the list quietly becomes the blind spot it was written to
 * close.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-env-doc.mjs', import.meta.url));

/**
 * Builds a throwaway tree: src/ reading `read` vars and an .env.example
 * documenting `documented`. `files` adds further files — used to stand in for
 * a cited source file whose snippet has drifted, which is how a stale
 * allowlist citation is exercised.
 */
function fixture(read, documented, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'env-doc-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'app.js'),
    read.map(name => `const x = process.env.${name};`).join('\n') + '\n',
  );
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  writeFileSync(join(dir, '.env.example'), documented.map(name => `${name}=`).join('\n') + '\n');
  return dir;
}

/** Runs the checker and returns its exit status and combined output. */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (err) {
    return { status: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Runs the checker against a fixture and removes the fixture afterwards. */
function runOnFixture(dir) {
  try {
    return run(['--root', dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the real repo passes the check', () => {
  const { status, output } = run([]);
  assert.equal(status, 0, `expected the real repo to pass, got:\n${output}`);
});

test('fails, naming the variable, when one read in src/ is absent from .env.example', () => {
  const dir = fixture(['FACILITATOR_URL', 'MAX_SESSION_SPEND_STROOPS'], ['FACILITATOR_URL']);
  const { status, output } = runOnFixture(dir);
  assert.equal(status, 1, `expected a failure, got:\n${output}`);
  assert.ok(
    output.includes('MAX_SESSION_SPEND_STROOPS'),
    `expected the failure to name MAX_SESSION_SPEND_STROOPS, got:\n${output}`,
  );
});

test('a commented-out default still counts as documented', () => {
  const dir = fixture(
    ['EMBEDDINGS_URL'],
    ['# EMBEDDINGS_URL=http://localhost:11434/api/embeddings'],
  );
  const { status, output } = runOnFixture(dir);
  assert.equal(status, 0, `expected the fixture to pass, got:\n${output}`);
});

test('fails, naming the variable, when one is documented but never read (#504)', () => {
  // The #504 case: STELLAR_SECRET was documented in .env.example and read
  // nowhere. The check used to report it as informational and wave it
  // through; now it is a failure until the entry is removed.
  const dir = fixture(['FACILITATOR_URL'], ['FACILITATOR_URL', 'STELLAR_SECRET']);
  const { status, output } = runOnFixture(dir);
  assert.equal(status, 1, `expected a failure, got:\n${output}`);
  assert.ok(
    output.includes('STELLAR_SECRET'),
    `expected the failure to name STELLAR_SECRET, got:\n${output}`,
  );
});

test('passes when a documented-but-dead name is on the allowlist', () => {
  // FACILITATOR_SECRET is read through a computed key (env[pluralKey] ??
  // env[singularKey]) and POSTGRES_PASSWORD is compose-only: both are
  // documented, neither is directly readable, and both are excused.
  const dir = fixture(['FACILITATOR_URL'], ['FACILITATOR_URL', 'FACILITATOR_SECRET']);
  const { status, output } = runOnFixture(dir);
  assert.equal(status, 0, `expected the fixture to pass, got:\n${output}`);

  const composeOnly = fixture(['FACILITATOR_URL'], ['FACILITATOR_URL', 'POSTGRES_PASSWORD']);
  const compose = runOnFixture(composeOnly);
  assert.equal(compose.status, 0, `expected the fixture to pass, got:\n${compose.output}`);
});

test('still fails when a documented name merely resembles an allowlisted one', () => {
  // The allowlist is a list of names, not a prefix family: a name that looks
  // like an excused one but is not on the list is dead documentation.
  const dir = fixture(['FACILITATOR_URL'], ['FACILITATOR_URL', 'FACILITATOR_SECRET_EXTRA']);
  const { status, output } = runOnFixture(dir);
  assert.equal(status, 1, `expected a failure, got:\n${output}`);
  assert.ok(
    output.includes('FACILITATOR_SECRET_EXTRA'),
    `expected the failure to name FACILITATOR_SECRET_EXTRA, got:\n${output}`,
  );
});

test('fails when an allowlist citation no longer matches the code', () => {
  // The allowlist must not outlive the code it excuses: if the cited snippet
  // is gone from the cited file, the entry has to be re-justified or removed.
  const dir = fixture(['FACILITATOR_URL'], ['FACILITATOR_URL'], {
    'src/config.js': 'export const noSecretsHere = true;\n',
  });
  const { status, output } = runOnFixture(dir);
  assert.equal(status, 1, `expected a failure, got:\n${output}`);
  assert.ok(
    output.includes('allowlist'),
    `expected the failure to report the stale allowlist entry, got:\n${output}`,
  );
});

test('fails, naming the variable, when one is documented but never read and not allowlisted', () => {
  // #504 regression: STELLAR_SECRET documented in .env.example, read nowhere.
  const dir = fixture([], ['STELLAR_SECRET=']);
  try {
    let output = '';
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, '--root', dir], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      err => {
        output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        return err.status === 1 && output.includes('STELLAR_SECRET');
      },
      `expected failure naming STELLAR_SECRET, got:\n${output}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passes when documented-but-dead names are on the declared-dead allowlist', () => {
  // Computed-read family (FACILITATOR_SECRET*) and a compose-only name
  // (POSTGRES_PASSWORD) are documented, never read, and explicitly excused.
  const dir = fixture([], ['FACILITATOR_SECRET=', 'POSTGRES_PASSWORD=']);
  try {
    execFileSync(process.execPath, [SCRIPT, '--root', dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
