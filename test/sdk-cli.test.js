import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The offline validator sellers are told to run in docs/SELLER.md and
 * docs/BAZAAR.md. Nothing else imports src/sdk/cli.js, so without this test a
 * broken import in it stays green through the whole suite — which is exactly
 * how it shipped once (it imported validateDiscoveryPolicy from ./validation.js,
 * where that symbol does not live).
 */
const CLI = fileURLToPath(new URL('../src/sdk/cli.js', import.meta.url));

function runCli(declaration) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'x402-cli-')), 'decl.json');
  fs.writeFileSync(file, JSON.stringify(declaration));
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [CLI, file], { encoding: 'utf8' }) };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('the CLI loads and accepts a well-formed declaration', () => {
  const { status, stdout } = runCli({
    routeTemplate: '/api/data/:id',
    pricing: { amount: '1', asset: 'USDC' },
  });
  assert.equal(status, 0);
  assert.match(stdout, /Validation passed/);
});

test('the CLI exits non-zero and names the reason on a hard drop', () => {
  const { status, stderr } = runCli('not-an-object');
  assert.equal(status, 1);
  assert.match(stderr, /invalid_declaration/);
});

test('the CLI explains itself when given no argument', () => {
  try {
    execFileSync(process.execPath, [CLI], { encoding: 'utf8' });
    assert.fail('expected a non-zero exit');
  } catch (err) {
    assert.equal(err.status, 1);
    // The usage line must show an invocation that actually works from a clean
    // clone — the package is private, so there is no installed bin name (#193).
    assert.match(err.stderr, /node src\/sdk\/cli\.js/);
  }
});
