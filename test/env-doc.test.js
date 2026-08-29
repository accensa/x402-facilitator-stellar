/**
 * Covers scripts/check-env-doc.mjs — the guard that keeps .env.example in
 * sync with the variables actually read in src/ (issue #144).
 *
 * The interesting failure is the one the script was written to catch: a
 * variable read in src/ with no entry in .env.example. The real repo must
 * pass; a fixture with a deliberately omitted variable must fail and name it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-env-doc.mjs', import.meta.url));

/** Builds a throwaway tree: src/ reading `read` vars and an .env.example documenting `documented`. */
function fixture(read, documented) {
  const dir = mkdtempSync(join(tmpdir(), 'env-doc-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'app.js'),
    read.map(name => `const x = process.env.${name};`).join('\n') + '\n',
  );
  writeFileSync(join(dir, '.env.example'), documented.map(name => `${name}=`).join('\n') + '\n');
  return dir;
}

test('the real repo passes the check', () => {
  execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
});

test('fails, naming the variable, when one read in src/ is absent from .env.example', () => {
  const dir = fixture(['FACILITATOR_URL', 'MAX_SESSION_SPEND_STROOPS'], ['FACILITATOR_URL']);
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
        return err.status === 1 && output.includes('MAX_SESSION_SPEND_STROOPS');
      },
      `expected failure naming MAX_SESSION_SPEND_STROOPS, got:\n${output}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a commented-out default still counts as documented', () => {
  const dir = fixture(
    ['EMBEDDINGS_URL'],
    ['# EMBEDDINGS_URL=http://localhost:11434/api/embeddings'],
  );
  try {
    execFileSync(process.execPath, [SCRIPT, '--root', dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
