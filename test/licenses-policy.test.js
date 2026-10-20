/**
 * Licence policy pins for scripts/check-licenses.mjs (#560).
 *
 * `npm run licenses` is the enforcement behind the permissive-licence promise
 * in README.md. Its whole policy is two pure functions — `licenseOf` (reads
 * every package.json shape npm has published) and `classify` (forbidden /
 * review / ok, including the dual-licence rule). Both are exported so this
 * test can pin the policy without walking node_modules or touching
 * process.exit; the materialised top-level walk is behind an
 * `argv[1] === fileURLToPath(import.meta.url)` guard instead.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { licenseOf, classify } from '../scripts/check-licenses.mjs';

describe('licenseOf', () => {
  test('reads a bare string licence', () => {
    assert.equal(licenseOf({ license: 'MIT' }), 'MIT');
  });

  test('reads the type out of a {type} object', () => {
    assert.equal(licenseOf({ license: { type: 'MIT' } }), 'MIT');
  });

  test('reads a licenses array of strings as an OR expression', () => {
    assert.equal(licenseOf({ licenses: ['MIT', 'Apache-2.0'] }), 'MIT OR Apache-2.0');
  });

  test('reads a legacy licenses array of objects', () => {
    assert.equal(
      licenseOf({ licenses: [{ type: 'MIT' }, { type: 'BSD-3-Clause' }] }),
      'MIT OR BSD-3-Clause',
    );
  });

  test('reports UNKNOWN when neither license nor licenses is declared', () => {
    assert.equal(licenseOf({}), 'UNKNOWN');
  });
});

describe('classify', () => {
  const forbiddenLicences = [
    'AGPL-3.0',
    'AGPL-3.0-only',
    'SSPL-1.0',
    'BUSL-1.1',
    'CC-BY-NC-4.0',
    '(AGPL-3.0 AND MIT)',
  ];
  for (const license of forbiddenLicences) {
    test(`forbidden: ${license}`, () => {
      assert.equal(classify(license), 'forbidden');
    });
  }

  const reviewLicences = ['GPL-3.0', 'GPL-2.0-only', 'LGPL-2.1', 'MPL-2.0', 'EPL-2.0', 'UNKNOWN'];
  for (const license of reviewLicences) {
    test(`review: ${license}`, () => {
      assert.equal(classify(license), 'review');
    });
  }

  test('a weak copyleft licence ORed with a permissive option is ok — we take the option', () => {
    assert.equal(classify('GPL-3.0 OR MIT'), 'ok');
    assert.equal(classify('LGPL-2.1 OR Apache-2.0'), 'ok');
    assert.equal(classify('MPL-2.0 OR MIT'), 'ok');
    assert.equal(classify('EPL-2.0 OR BSD-3-Clause'), 'ok');
  });

  test('a weak copyleft licence ANDed with a permissive option is not ok', () => {
    assert.equal(classify('GPL-3.0 AND MIT'), 'review');
  });

  const okLicences = ['Apache-2.0', 'MIT', 'BSD-3-Clause', 'ISC', '0BSD', 'MIT OR Apache-2.0'];
  for (const license of okLicences) {
    test(`ok: ${license}`, () => {
      assert.equal(classify(license), 'ok');
    });
  }
});
