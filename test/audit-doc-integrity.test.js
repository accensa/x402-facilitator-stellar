import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_MD_PATH = path.join(ROOT, 'docs/AUDIT.md');
const content = readFileSync(AUDIT_MD_PATH, 'utf8');

test('docs/AUDIT.md headings are unique and well-formed (#775)', () => {
  const lines = content.split('\n');
  const headings = [];
  const headingCounts = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const title = match[2].trim();
      const fullHeading = `${match[1]} ${title}`;
      headings.push({ level, title, fullHeading, lineNumber: i + 1 });

      const count = headingCounts.get(fullHeading) || 0;
      headingCounts.set(fullHeading, count + 1);
    }
  }

  // Find any duplicates
  const duplicates = [];
  for (const [heading, count] of headingCounts.entries()) {
    if (count > 1) {
      duplicates.push(`${heading} (found ${count} times)`);
    }
  }

  assert.equal(
    duplicates.length,
    0,
    `Found duplicate markdown headings in docs/AUDIT.md: ${duplicates.join(', ')}`,
  );
});

test('docs/AUDIT.md has exactly one "## Proposed Scope" section heading (#775)', () => {
  const matches = content.match(/^##\s+Proposed Scope\s*$/gm);
  assert.ok(matches, 'docs/AUDIT.md must have a "## Proposed Scope" heading');
  assert.equal(
    matches.length,
    1,
    `Expected exactly 1 "## Proposed Scope" heading in docs/AUDIT.md, got ${matches.length}`,
  );
});

test('docs/AUDIT.md headings are well-formed and follow syntax standards', () => {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s*(.*)$/);
    if (match) {
      // If line starts with # followed by a digit like "#7 covers...", it is an issue reference, not a heading
      if (/^#\d+/.test(line)) continue;
      assert.ok(
        line.match(/^#{1,6}\s+\S/),
        `Malformed heading on line ${i + 1} of docs/AUDIT.md: "${line}" (needs space after # and non-empty title)`,
      );
    }
  }
});
