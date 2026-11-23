import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DESCRIPTION_LENGTH, validateDiscoveryDeclaration } from '../src/sdk/validation.js';
import { validateDiscoveryPolicy } from '../src/catalog/validation.js';

/**
 * Description length bound shared by the SDK and the catalog (#700).
 *
 * The catalog truncates descriptions longer than MAX_DESCRIPTION_LENGTH, which
 * silently discards the seller's text. The SDK now rejects such a declaration
 * at authoring time, using the same 200 UTF-16-code-unit bound.
 */

function declaration(description) {
  return {
    routeTemplate: '/api/ping',
    pricing: { amount: '1', asset: 'XLM' },
    ...(description === undefined ? {} : { description }),
  };
}

function errorsFor(description) {
  return validateDiscoveryDeclaration(declaration(description));
}

function catalogPolicyFor(description) {
  return validateDiscoveryPolicy({
    routeTemplate: '/api/ping',
    url: 'https://api.example.com/ping',
    description,
  });
}

test('the exported bound is the catalog value', () => {
  assert.equal(MAX_DESCRIPTION_LENGTH, 200);
});

test('an omitted description is accepted', () => {
  assert.deepEqual(errorsFor(undefined), []);
});

test('descriptions at or below the bound are accepted', () => {
  for (const length of [0, 1, 100, MAX_DESCRIPTION_LENGTH - 1, MAX_DESCRIPTION_LENGTH]) {
    assert.deepEqual(
      errorsFor('a'.repeat(length)),
      [],
      `expected a ${length}-character description to be accepted`,
    );
  }
});

test('a description one code unit over the bound is rejected', () => {
  const errors = errorsFor('a'.repeat(MAX_DESCRIPTION_LENGTH + 1));
  assert.deepEqual(errors, [
    `description must be at most ${MAX_DESCRIPTION_LENGTH} characters (got ${MAX_DESCRIPTION_LENGTH + 1})`,
  ]);
});

test('the bound is measured in UTF-16 code units, matching the catalog', () => {
  // Each emoji is two code units, so 100 fit exactly and 101 do not.
  assert.deepEqual(errorsFor('😀'.repeat(MAX_DESCRIPTION_LENGTH / 2)), []);
  const errors = errorsFor('😀'.repeat(MAX_DESCRIPTION_LENGTH / 2 + 1));
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes(`at most ${MAX_DESCRIPTION_LENGTH} characters`));
});

test('the catalog truncates at the same bound the SDK enforces', () => {
  const atBound = catalogPolicyFor('a'.repeat(MAX_DESCRIPTION_LENGTH));
  assert.equal(atBound.hardDrop, false);
  assert.deepEqual(atBound.truncations, []);
  assert.equal(atBound.resource.description.length, MAX_DESCRIPTION_LENGTH);

  const overBound = catalogPolicyFor('a'.repeat(MAX_DESCRIPTION_LENGTH + 1));
  assert.equal(overBound.hardDrop, false);
  assert.deepEqual(overBound.truncations, ['description']);
  assert.equal(overBound.resource.description.length, MAX_DESCRIPTION_LENGTH);
});
