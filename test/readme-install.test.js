/**
 * The README install instruction (#485).
 *
 * README.md told readers to `npm install -g @accensa/x402-facilitator-stellar`,
 * but `npm view` on that name returns E404 — the package has never been
 * published, so the instruction cannot work for anyone following the docs.
 * The supported path is a source build (kept here, not in the registry note),
 * and this content check fails the suite if a bare registry install of the
 * unpublished name ever returns to the docs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('README.md:117 — no bare registry install of the unpublished package', () => {
  const bareInstall = [
    ...README.matchAll(/npm\s+(?:install|i)\s+(?:-g\s+)?@accensa\/x402-facilitator-stellar/g),
  ];
  assert.deepEqual(
    bareInstall.map(m => m[0]),
    [],
    'README must not instruct `npm install [-g] @accensa/x402-facilitator-stellar`: no release exists',
  );
});

test('README.md:117 — the install section names the missing release and the source path', () => {
  assert.match(
    README,
    /[Nn]o npm release|[Nn]ot published|E404/,
    'must say no npm release exists yet',
  );
  assert.match(README, /git clone .*x402-facilitator-stellar/, 'must give the source build path');
  assert.match(README, /npm ci/, 'source path must install from the lockfile');
});

test('README.md:117 — the Node version requirement is stated next to the install', () => {
  assert.match(README, /Node\s+`?>=\s*20/, 'must state the engines range');
  assert.match(README, /Node 22/, 'must state the developed-and-tested version');
});
