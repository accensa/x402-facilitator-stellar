/**
 * Issue #146 honesty checks for the EXTENSION-RESPONSES documentation.
 *
 * The header is the only channel a seller has to learn what the Bazaar did
 * with their resource, so the documented contract must not drift from the
 * code: if a new status, code, or soft-dropped field is added to the
 * cataloging path without appearing in docs/BAZAAR.md, that is the same gap
 * the issue set out to close, one level down.
 *
 * Two directions are enforced:
 *   - every code-like literal the cataloging path emits is documented in
 *     docs/BAZAAR.md (extracted from src/app.js and src/catalog/validation.js
 *     with patterns that only match the cataloging assignments);
 *   - every EXTENSION-RESPONSES example in the docs actually base64-decodes
 *     to a well-formed { bazaar: { status, ... } } envelope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

const appSource = read('src/app.js');
const validationSource = read('src/catalog/validation.js');
const bazaarDoc = read('docs/BAZAAR.md');

/** Every status/code the cataloging path can put in the envelope. */
function codesEmitted() {
  const outcome = [...appSource.matchAll(/outcome\.(?:status|code|reason)\s*=\s*'([^']+)'/g)].map(
    m => m[1],
  );
  const reasons = [...validationSource.matchAll(/(?:result\.reason)\s*=\s*'([^']+)'/g)].map(
    m => m[1],
  );
  const softDrops = [...validationSource.matchAll(/result\.softDrops\.push\(\s*'([^']+)'/g)].map(
    m => m[1],
  );
  return [...new Set([...outcome, ...reasons, ...softDrops])];
}

test('every catalog code emitted by the source is documented in docs/BAZAAR.md', () => {
  const missing = codesEmitted().filter(code => !bazaarDoc.includes(code));
  assert.deepEqual(
    missing,
    [],
    `codes emitted by the cataloging path but missing from docs/BAZAAR.md: ${missing.join(', ')}`,
  );
});

test('the four outcome statuses are all documented', () => {
  for (const status of ['not attempted', 'landed', 'partially landed', 'rejected']) {
    assert.ok(
      bazaarDoc.includes(`\`${status}\``),
      `docs/BAZAAR.md should document status \`${status}\``,
    );
  }
});

test('every EXTENSION-RESPONSES example in the docs decodes to a valid bazaar envelope', () => {
  const examples = [...bazaarDoc.matchAll(/EXTENSION-RESPONSES:\s*([A-Za-z0-9+/=]+)/g)].map(
    m => m[1],
  );
  assert.ok(examples.length >= 2, 'expected at least the landed and rejected worked examples');
  for (const encoded of examples) {
    let envelope;
    assert.doesNotThrow(() => {
      envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    }, `example ${encoded} must base64-decode to JSON`);
    assert.ok(
      envelope?.bazaar && typeof envelope.bazaar === 'object',
      `example ${encoded} must decode to a { bazaar: ... } envelope`,
    );
    assert.ok(
      ['not attempted', 'landed', 'partially landed', 'rejected'].includes(envelope.bazaar.status),
      `example ${encoded} decodes to an unknown status ${envelope.bazaar.status}`,
    );
  }
});

test('the docs mention the header, the decode one-liner, and link from the Seller Guide', () => {
  assert.match(bazaarDoc, /EXTENSION-RESPONSES/);
  assert.match(bazaarDoc, /base64 -d \| jq/);
  const sellerDoc = read('docs/SELLER.md');
  assert.ok(
    sellerDoc.includes('EXTENSION-RESPONSES') && sellerDoc.includes('BAZAAR.md'),
    'docs/SELLER.md should cross-link the EXTENSION-RESPONSES section in docs/BAZAAR.md',
  );
});
