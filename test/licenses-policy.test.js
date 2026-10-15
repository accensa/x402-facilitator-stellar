/**
 * The licence policy the build gate enforces — asserted as a table (#560).
 *
 * `npm run licenses` (scripts/check-licenses.mjs) is the enforcement behind
 * the permissive-licence promise. Its two pure functions decide whether a
 * build ships:
 *   - `licenseOf` reads every manifest shape npm has published: a bare
 *     string, an SPDX expression, a `{type}` object, a legacy `licenses`
 *     array, or nothing at all (`UNKNOWN`);
 *   - `classify` maps a licence string onto `forbidden` / `review` / `ok`,
 *     including the rule that a weak-copyleft licence offered together with a
 *     permissive option via `OR` is acceptable — we take that option.
 *
 * The module is imported, never executed as a CLI in this file: the top-level
 * walk/exit block is behind a main-module guard, so importing is
 * side-effect-free and no fixture tree under node_modules is needed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { licenseOf, classify } from '../scripts/check-licenses.mjs';

describe('licenseOf reads every manifest shape', () => {
  test('a bare license string passes through', () => {
    assert.strictEqual(licenseOf({ license: 'MIT' }), 'MIT');
  });

  test('an SPDX expression string passes through', () => {
    assert.strictEqual(licenseOf({ license: '(MIT OR Apache-2.0)' }), '(MIT OR Apache-2.0)');
  });

  test('a {type} object yields its type', () => {
    assert.strictEqual(licenseOf({ license: { type: 'MIT' } }), 'MIT');
  });

  test('a legacy licenses array of {type} objects joins with OR', () => {
    assert.strictEqual(
      licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
      'MIT OR Apache-2.0',
    );
  });

  test('a legacy licenses array of bare strings joins with OR', () => {
    assert.strictEqual(licenseOf({ licenses: ['GPL-3.0', 'MIT'] }), 'GPL-3.0 OR MIT');
  });

  test('a package with neither license nor licenses is UNKNOWN', () => {
    assert.strictEqual(licenseOf({ name: 'ghost', version: '1.0.0' }), 'UNKNOWN');
  });
});

describe('classify decides the shipped/review/forbidden table', () => {
  test('the named forbidden licences fail the build', () => {
    for (const license of ['AGPL-3.0', 'SSPL-1.0', 'BUSL-1.1', 'CC-BY-NC-4.0']) {
      assert.strictEqual(classify(license), 'forbidden', `${license} is forbidden`);
    }
  });

  test('a bare weak-copyleft licence goes to a human review', () => {
    for (const license of ['GPL-3.0', 'LGPL-2.1', 'MPL-2.0', 'EPL-2.0']) {
      assert.strictEqual(classify(license), 'review', `${license} is review`);
    }
  });

  test('the same weak-copyleft names with a permissive OR option are acceptable', () => {
    for (const license of [
      'GPL-3.0 OR MIT',
      'LGPL-2.1 OR Apache-2.0',
      'MPL-2.0 OR Apache-2.0',
      'EPL-2.0 OR MIT',
    ]) {
      assert.strictEqual(classify(license), 'ok', `${license} is ok`);
    }
  });

  test('UNKNOWN needs a human look', () => {
    assert.strictEqual(classify('UNKNOWN'), 'review');
  });

  test('the permissive workhorses pass', () => {
    for (const license of ['Apache-2.0', 'MIT', 'BSD-3-Clause']) {
      assert.strictEqual(classify(license), 'ok', `${license} is ok`);
    }
  });

  test('a legacy manifest whose array mixes copyleft with a permissive option passes', () => {
    // The shape npm used ~2014: licenses as an array of objects. After
    // licenseOf joins it, classify must see the OR and take the permissive
    // half.
    assert.strictEqual(
      classify(licenseOf({ licenses: [{ type: 'GPL-3.0' }, { type: 'MIT' }] })),
      'ok',
    );
  });

  test('case-insensitive: forbidden text inside a sentence still fails', () => {
    assert.strictEqual(classify('AGPL-3.0-or-later'), 'forbidden');
  });
});
