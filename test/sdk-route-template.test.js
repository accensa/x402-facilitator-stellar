import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscoveryDeclaration } from '../src/sdk/validation.js';

/**
 * Route-template placeholder validation (#702).
 *
 * Isolation matters here: validateDiscoveryDeclaration returns every error in
 * one array, so these tests keep pricing permanently valid and pass only the
 * route template and its parameter descriptions. Each assertion is then the
 * complete error list for the placeholder surface — not a `.some()` that would
 * stay green if an extra, unexpected error appeared alongside it.
 */
const PRICING = { amount: '1', asset: 'USDC' };

const EMPTY_PLACEHOLDER = 'routeTemplate contains an empty parameter placeholder';
const invalidName = name => `Invalid routeTemplate parameter name: ${name}`;
const missingDescription = name => `Missing description for parameter: ${name}`;

function validate(routeTemplate, parameters = {}) {
  return validateDiscoveryDeclaration({ routeTemplate, parameters, pricing: PRICING });
}

test('whitespace-only placeholders report the exact empty-placeholder error', () => {
  for (const template of ['{ }', '{\t}', '{   }', '{\n}', '/api/{ }/weather', '/a/{ \t }/b']) {
    assert.deepEqual(validate(template), [EMPTY_PLACEHOLDER], template);
  }
});

test('a bare {} is not extracted, so it does not trigger the empty-placeholder branch', () => {
  // The extraction regex is /\{([^}]+)\}/g: at least one character is required
  // between the braces. Whitespace matches and then trims to '', which is the
  // reachable "empty" branch; a literal '{}' never reaches it. This pins the
  // implemented behaviour rather than the issue's shorthand.
  assert.deepEqual(validate('/api/{}'), []);
  assert.deepEqual(validate('/api/{}/v2/{}'), []);
});

test('valid parameter identifiers are accepted and looked up by their trimmed name', () => {
  assert.deepEqual(
    validate('/a/{id}/b/{user_id}/c/{_private}/d/{a1}/e/{A_B9}', {
      id: 'ID',
      user_id: 'User',
      _private: 'Private',
      a1: 'A one',
      A_B9: 'Upper',
    }),
    [],
  );

  // Trimming happens before both syntax validation and description lookup.
  assert.deepEqual(validate('/api/{ id }', { id: 'Trimmed' }), []);
});

test('invalid parameter identifiers are rejected with the exact message', () => {
  const cases = [
    ['/api/{123}', '123'],
    ['/api/{1id}', '1id'],
    ['/api/{bad-param}', 'bad-param'],
    ['/api/{bad param}', 'bad param'],
    ['/api/{a.b}', 'a.b'],
    ['/api/{id!}', 'id!'],
    ['/api/{id?}', 'id?'],
    ['/api/{café}', 'café'],
  ];

  for (const [template, name] of cases) {
    assert.deepEqual(validate(template), [invalidName(name)], template);
  }
});

test('parameter names are trimmed before identifier validation', () => {
  assert.deepEqual(validate('/api/{ 123 }'), [invalidName('123')]);
  assert.deepEqual(validate('/api/{ bad-param }'), [invalidName('bad-param')]);
});

test('a valid parameter without a usable description reports it exactly once', () => {
  assert.deepEqual(validate('/api/{id}'), [missingDescription('id')]);

  // Empty, whitespace-only and non-string descriptions are not descriptions.
  for (const description of ['', '   ', null, 42, true, {}]) {
    assert.deepEqual(validate('/api/{id}', { id: description }), [missingDescription('id')]);
  }

  assert.deepEqual(validate('/api/{id}', { id: 'The entity id' }), []);
});

test('repeated valid parameters report a missing description only once', () => {
  assert.deepEqual(validate('/items/{id}/history/{id}'), [missingDescription('id')]);
  assert.deepEqual(validate('/items/{id}/history/{id}/again/{id}'), [missingDescription('id')]);

  // Deduplication follows first appearance of each unique name.
  assert.deepEqual(validate('/{id}/{name}/{id}/{name}'), [
    missingDescription('id'),
    missingDescription('name'),
  ]);

  // A described repeat is not an error, and does not mask another parameter.
  assert.deepEqual(validate('/{id}/{name}/{id}', { id: 'ID' }), [missingDescription('name')]);
});

test('partial descriptions report only the undescribed parameters, in template order', () => {
  const template = '/api/{org}/repos/{repo}/issues/{issue}';

  assert.deepEqual(validate(template, { repo: 'Repository', issue: 'Issue number' }), [
    missingDescription('org'),
  ]);
  assert.deepEqual(validate(template, { org: 'Organisation', issue: 'Issue number' }), [
    missingDescription('repo'),
  ]);
  assert.deepEqual(validate(template, { repo: 'Repository' }), [
    missingDescription('org'),
    missingDescription('issue'),
  ]);
  assert.deepEqual(
    validate(template, { org: 'Organisation', repo: 'Repository', issue: 'Issue number' }),
    [],
  );

  // Descriptions for names the template does not use are ignored.
  assert.deepEqual(
    validate(template, {
      org: 'Organisation',
      repo: 'Repository',
      issue: 'Issue number',
      unused: 'Unused',
    }),
    [],
  );
});

test('mixed empty, invalid, duplicate and missing placeholders are reported in template order', () => {
  const template = '/v1/{ }/{123}/{id}/{id}/{org}/{bad-name}/{org}/{repo}';

  assert.deepEqual(validate(template, { org: 'Organisation', repo: 'Repository' }), [
    EMPTY_PLACEHOLDER,
    invalidName('123'),
    missingDescription('id'),
    invalidName('bad-name'),
  ]);
});

test('deduplication applies only to valid parameter names', () => {
  // Empty and invalid placeholders are not added to the seen set, so a repeat
  // is reported again rather than being silently swallowed by deduplication.
  assert.deepEqual(validate('/a/{ }/{ }'), [EMPTY_PLACEHOLDER, EMPTY_PLACEHOLDER]);
  assert.deepEqual(validate('/a/{bad-name}/{bad-name}'), [
    invalidName('bad-name'),
    invalidName('bad-name'),
  ]);
});
