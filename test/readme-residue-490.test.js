import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/docs-links.yml'), 'utf8');

test('README has no merge-conflict residue as prose (#490, README.md:84)', () => {
  for (const line of README.split('\n')) {
    const trimmed = line.trim();
    assert.notEqual(trimmed, 'feat/upstream-drift-watch', 'branch-name residue line remains');
    assert.notEqual(trimmed, 'main', 'branch-name residue line remains');
    assert.notEqual(trimmed, 'docs/conformance', 'branch-name residue line remains');
    assert.notEqual(trimmed, '// fix', 'stray token remains');
  }
  assert.ok(!README.includes('feat/upstream-drift-watch'), 'residue token still present');
  assert.ok(!README.match(/^\s*docs\/conformance\s*$/m), 'residue token still present');
  assert.ok(!README.match(/\/\/ fix\s*$/m), 'trailing token still present');
  // License wording stays intact.
  assert.match(README, /Apache-2\.0 — see \[LICENSE\]\(LICENSE\)/);
});

test('docs-links job covers the repository root and scans for conflict markers (#490)', () => {
  // The docs/ action step keeps its original scope; a dedicated step checks
  // the root markdown so subdirectory surfaces owned elsewhere stay out.
  assert.match(
    WORKFLOW,
    /folder-path:\s*['"]docs['"]/,
    'the docs action step must keep checking docs/',
  );
  assert.match(WORKFLOW, /Check root markdown links/, 'a root-markdown link step must exist');
  assert.match(WORKFLOW, /\*\.md/, 'the root step must cover the root markdown files');
  assert.match(WORKFLOW, /gulp|grep|conflict|<<<<<<</i, 'job must include a conflict-marker scan');
  assert.match(WORKFLOW, /'\*\.md'/, 'pull_request paths must include root markdown');
  assert.ok(
    !WORKFLOW.match(/^\s*checkout:\s*/m),
    "'checkout' is not a valid action input and must not be passed",
  );
});
