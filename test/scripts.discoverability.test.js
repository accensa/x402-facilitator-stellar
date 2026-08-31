/**
 * Encodes issue #147's acceptance criterion: every script in scripts/ is
 * either wired to an npm script in package.json or documented in the README.
 * A new script that is neither is a regression this test catches — it is the
 * same check the issue's repro ran by hand:
 *
 *   for s in scripts/*; do b=$(basename $s); \
 *     (grep -q "$b" package.json || grep -q "$b" README.md) || echo "$b"; done
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
