/**
 * A CHANGELOG only helps an integrator if it is kept up (#212). This guards the
 * shape — a top-level heading, an Unreleased section to add to, and the
 * released 0.0.1 entry — and that the README points at it, so it cannot be
 * quietly orphaned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('CHANGELOG.md is Keep-a-Changelog shaped with an Unreleased section', () => {
  const doc = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(doc, /^# Changelog/m);
  assert.match(doc, /Keep a Changelog/i);
  assert.match(doc, /## \[Unreleased\]/);
  assert.match(doc, /## \[0\.0\.1\]/);
});

test('the README links the changelog', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /\[Changelog\]\(CHANGELOG\.md\)/);
});
