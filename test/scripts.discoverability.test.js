/**
 * Encodes issue #147's acceptance criterion: every script in scripts/ is
 * either wired to an npm script in package.json or documented in the README.
 * A new script that is neither is a regression this test catches — it is the
 * same check the issue's repro ran by hand:
 *
 *   for s in scripts/*; do b=$(basename $s); \
 *     (grep -q "$b" package.json || grep -q "$b" README.md) || echo "$b"; done
 *
 * The mirror-image check is below: a command a document tells the reader to
 * run must exist. docs/BUYER.md, docs/ONBOARDING_TIMING.md,
 * examples/http-seller/README.md and examples/mcp-agent/README.md once said
 * `npm run fund:testnet` / `npm run prepare:testnet-usdc` — neither is a key
 * of package.json's scripts — and every CI run passed over that dead end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const scripts = readdirSync(join(ROOT, 'scripts'));
const packageJson = readFileSync(join(ROOT, 'package.json'), 'utf8');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const packageScripts = JSON.parse(packageJson).scripts ?? {};

test('every script in scripts/ is referenced by package.json or the README', () => {
  const orphaned = scripts.filter(name => !packageJson.includes(name) && !readme.includes(name));
  assert.deepEqual(
    orphaned,
    [],
    `scripts not referenced anywhere: ${orphaned.join(', ')} — wire them to an npm script or document them in README.md`,
  );
});

test('the testnet setup helpers have npm scripts', () => {
  for (const [script, file] of [
    ['testnet:fund', 'fund-testnet-accounts.mjs'],
    ['testnet:usdc', 'prepare-testnet-usdc.mjs'],
  ]) {
    assert.ok(
      packageJson.includes(`"${script}"`) && packageJson.includes(file),
      `expected package.json to wire ${script} -> ${file}`,
    );
  }
});

test('the README testing section references the testnet setup scripts', () => {
  assert.ok(
    readme.includes('npm run testnet:fund'),
    'README should point contributors at testnet:fund',
  );
  assert.ok(
    readme.includes('npm run testnet:usdc'),
    'README should point contributors at testnet:usdc',
  );
});

test('data_retention_job.js is documented as not implemented, not as working tooling', () => {
  const row = readme.split('\n').find(line => line.includes('data_retention_job.js'));
  assert.ok(row, 'README must mention data_retention_job.js');
  assert.match(row, /not implemented/i);
  assert.match(readme, /Issue #50/);
});

/**
 * Documents scanned by the reverse check: the two top-level guides, every
 * markdown file under docs/, and every README under examples/. CHANGELOG.md
 * and SECURITY.md are deliberately excluded — a changelog quotes commands as
 * they were, and a security doc quotes commands it tells you not to run.
 */
function scannedDocuments() {
  const found = [];
  const walk = (dir, accept) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, accept);
      else if (accept(entry.name)) found.push(path);
    }
  };
  found.push('README.md', 'CONTRIBUTING.md');
  walk('docs', name => name.endsWith('.md'));
  walk('examples', name => name === 'README.md');
  return found;
}

/**
 * Commands a document quotes even though they are intentionally not keys of
 * package.json — each entry must say why it is allowed, so an entry can never
 * be added just to silence the check. Empty today: the rename to
 * testnet:fund / testnet:usdc landed first, so every invocation in scope
 * resolves. Shape: { file, script, why }.
 */
const ALLOWED_MISSING = [
  // { file: 'docs/EXAMPLE.md', script: 'fund:testnet', why: 'quoted as the pre-rename name in a historical note' },
];

const ALLOWED = new Set(ALLOWED_MISSING.map(({ file, script }) => `${file}\u0000${script}`));

/**
 * Every `npm run <name>` and `npm test` invocation on one line, as
 * `file:line — command → script key`.
 *
 * - `\bnpm` keeps `pnpm test` / `pnpm run …` (docs/CONFORMANCE.md quotes the
 *   upstream repo's commands) from matching on the trailing "npm".
 * - `npm test` is a bare token mapping to the `test` key, so prose like
 *   "npm test runs on Node 20" is checked instead of silently skipped, and
 *   trailing arguments (`npm test -- test/foo.test.js`) are ignored.
 * - Trailing punctuation is stripped: `npm run format.`, `` `npm run eval`** ``.
 */
function npmInvocations(file) {
  const invocations = [];
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const seen = new Set();
    const add = (script, command) => {
      if (seen.has(script)) return;
      seen.add(script);
      invocations.push({ file, line: index + 1, script, command });
    };
    for (const match of line.matchAll(/\bnpm run ([A-Za-z0-9][A-Za-z0-9:.@_-]*)/g)) {
      const script = match[1].replace(/[.,;:!?')\]}`]+$/, '');
      add(script, `npm run ${script}`);
    }
    if (/\bnpm test\b/.test(line)) add('test', 'npm test');
  });
  return invocations;
}

test('every npm command named in the docs is a script in package.json', () => {
  const violations = [];
  for (const file of scannedDocuments()) {
    for (const { line, script, command } of npmInvocations(file)) {
      if (Object.hasOwn(packageScripts, script)) continue;
      if (ALLOWED.has(`${file}\u0000${script}`)) continue;
      violations.push(`  ${file}:${line} — \`${command}\` → no "${script}" script in package.json`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `docs name npm scripts that do not exist (fix the document, or add an allowlist entry with a reason):\n${violations.join('\n')}`,
  );
});

test('the npm-command allowlist entries are all used and all say why', () => {
  for (const entry of ALLOWED_MISSING) {
    assert.ok(
      entry.why && entry.why.trim().length > 0,
      `allowlist entry ${entry.file} → ${entry.script} must say why it is allowed`,
    );
    const used = npmInvocations(entry.file).some(({ script }) => script === entry.script);
    assert.ok(
      used && !Object.hasOwn(packageScripts, entry.script),
      `allowlist entry ${entry.file} → ${entry.script} matches nothing dead; remove it`,
    );
  }
});
