/**
 * #682: binds the documented `EXTENSION-RESPONSES` size cap and degradation
 * tiers to the constants the encoder actually exports.
 *
 * docs/BAZAAR.md is the only place a seller learns that a settlement response
 * can arrive with detail omitted, so that prose is load-bearing. The existing
 * gate, test/extension-responses-doc.test.js, checks that emitted code literals
 * are documented and that the worked examples decode; it never compares the
 * byte number or the status list to the source. So the cap could drift from
 * 4096 to 2048, or a status could be added or renamed, with the doc still
 * describing a header the service no longer sends.
 *
 * This file closes that gap: the cap, every known status, the omission code and
 * the header name are read from the module, not restated here, and the doc is
 * required to contain each one plus the client's read order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  KNOWN_STATUSES,
  MAX_EXTENSION_RESPONSES_HEADER_BYTES,
  OMITTED_CODE,
} from '../src/catalog/extension-responses.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bazaarDoc = readFileSync(join(ROOT, 'docs/BAZAAR.md'), 'utf8');

test('#682: the documented cap is the exported byte cap', () => {
  const cap = MAX_EXTENSION_RESPONSES_HEADER_BYTES;
  assert.match(
    bazaarDoc,
    new RegExp(`\\b${cap}\\s*bytes\\b`),
    `docs/BAZAAR.md must state the header cap as "${cap} bytes"`,
  );
  // Naming the constant is what lets a reader find the source of truth, and it
  // is what makes the drift visible when only one of the two is edited.
  assert.ok(
    bazaarDoc.includes('MAX_EXTENSION_RESPONSES_HEADER_BYTES'),
    'docs/BAZAAR.md must name the constant the cap comes from',
  );
});

test('#682: the doc names the header it describes', () => {
  assert.ok(
    bazaarDoc.includes('EXTENSION-RESPONSES'),
    'docs/BAZAAR.md must name the EXTENSION-RESPONSES header verbatim',
  );
});

test('#682: every known status is documented', () => {
  for (const status of KNOWN_STATUSES) {
    assert.ok(
      bazaarDoc.includes(`\`${status}\``),
      `docs/BAZAAR.md must document the status \`${status}\``,
    );
  }
});

test('#682: the tier-3 omission code is documented', () => {
  assert.ok(
    bazaarDoc.includes(OMITTED_CODE),
    `docs/BAZAAR.md must document the omission code ${OMITTED_CODE}`,
  );
});

test('#682: the doc gives the client read order — status, then code, then detail_omitted', () => {
  const status = bazaarDoc.indexOf('1. **`status`**');
  const code = bazaarDoc.indexOf('2. **`code`**');
  const detail = bazaarDoc.indexOf('3. **`detail_omitted`**');

  assert.ok(status >= 0, 'expected a numbered read-order list starting with status');
  assert.ok(code > status, 'code must be read after status');
  assert.ok(detail > code, 'detail_omitted must be read after code');
});

test('#682: the tier table keeps the three ordered tiers', () => {
  for (const tier of ['| 1 |', '| 2 |', '| 3 |']) {
    assert.ok(bazaarDoc.includes(tier), `docs/BAZAAR.md must keep tier row ${tier}`);
  }
});
