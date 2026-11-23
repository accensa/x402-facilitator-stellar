import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscoveryDeclaration } from '../src/sdk/validation.js';

/**
 * Shape validation for optional discovery metadata (#699).
 *
 * The catalog expects `tags` to be an array of strings and validates `url` as
 * an HTTP(S) URL. Without SDK-side checks a malformed declaration is accepted
 * at authoring time and then crashes or is silently filtered during catalog
 * ingestion. These tests pin the authoring-time contract.
 */

function errorsFor(overrides = {}) {
  return validateDiscoveryDeclaration({
    routeTemplate: '/api/ping',
    pricing: { amount: '1', asset: 'XLM' },
    ...overrides,
  });
}

test('optional metadata may be omitted entirely', () => {
  assert.deepEqual(errorsFor(), []);
});

test('well-formed tags, url, and serviceName are accepted', () => {
  assert.deepEqual(errorsFor({ tags: [] }), []);
  assert.deepEqual(errorsFor({ tags: ['weather', 'forecast'] }), []);
  assert.deepEqual(errorsFor({ url: 'https://api.example.com/weather' }), []);
  assert.deepEqual(errorsFor({ url: 'http://localhost:3402/api' }), []);
  assert.deepEqual(errorsFor({ serviceName: 'Weather API' }), []);
  assert.deepEqual(errorsFor({ serviceName: 'A'.repeat(32) }), []);
  assert.deepEqual(
    errorsFor({
      tags: ['weather'],
      url: 'https://api.example.com/weather',
      serviceName: 'Weather API',
    }),
    [],
  );
});

test('tags must be an array when provided', () => {
  for (const tags of ['weather', 42, true, null, {}, { 0: 'weather' }]) {
    const errors = errorsFor({ tags });
    assert.ok(
      errors.includes('tags must be an array of strings'),
      `expected ${String(tags)} (${typeof tags}) to be rejected, got ${JSON.stringify(errors)}`,
    );
  }
});

test('every tag must be a non-empty string', () => {
  const cases = [
    [['weather', 1], 'tags[1] must be a non-empty string'],
    [['weather', null], 'tags[1] must be a non-empty string'],
    [['weather', {}], 'tags[1] must be a non-empty string'],
    [[true], 'tags[0] must be a non-empty string'],
    [[''], 'tags[0] must be a non-empty string'],
    [['   '], 'tags[0] must be a non-empty string'],
  ];

  for (const [tags, expected] of cases) {
    const errors = errorsFor({ tags });
    assert.ok(
      errors.includes(expected),
      `expected ${JSON.stringify(tags)} to report "${expected}", got ${JSON.stringify(errors)}`,
    );
  }
});

test('url must be a parseable HTTP or HTTPS URL when provided', () => {
  const invalid = [
    42,
    null,
    '',
    'example.com/api',
    '/relative/path',
    'ftp://example.com/file',
    'mailto:seller@example.com',
    'javascript:alert(1)',
    'http://[invalid-ipv6',
  ];

  for (const url of invalid) {
    const errors = errorsFor({ url });
    assert.ok(
      errors.includes('url must be a valid HTTP or HTTPS URL'),
      `expected ${String(url)} (${typeof url}) to be rejected, got ${JSON.stringify(errors)}`,
    );
  }
});

test('serviceName must be a non-empty string within 32 characters', () => {
  for (const serviceName of [42, true, null, {}, [], '', '   ']) {
    const errors = errorsFor({ serviceName });
    assert.ok(
      errors.includes('serviceName must be a non-empty string'),
      `expected ${String(serviceName)} (${typeof serviceName}) to be rejected, got ${JSON.stringify(errors)}`,
    );
  }

  const oversized = errorsFor({ serviceName: 'A'.repeat(33) });
  assert.ok(oversized.includes('serviceName must be at most 32 characters'));
});

test('all malformed optional fields are reported together', () => {
  const errors = errorsFor({
    tags: 'weather',
    url: 'ftp://example.com/file',
    serviceName: '',
  });

  assert.equal(errors.length, 3);
  assert.ok(errors.includes('tags must be an array of strings'));
  assert.ok(errors.includes('url must be a valid HTTP or HTTPS URL'));
  assert.ok(errors.includes('serviceName must be a non-empty string'));
});
