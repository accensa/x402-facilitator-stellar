/**
 * Characterisation of the errors module's public surface (#662).
 *
 * The module exports six error classes but the `errors` map exposes only two
 * helpers. Consumers iterate that map and branch on `code`, so both the map's
 * exact keys and each class's literal code/name are pinned here. Expected
 * values are literals, never imported from the source, so an accidental change
 * to a code or a class name fails this test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FacilitatorError,
  InvalidRequestError,
  NotFoundError,
  UnauthorizedError,
  RateLimitError,
  ServiceUnavailableError,
  errors,
} from '../src/errors.js';

test('the errors map exposes exactly internalError and rateLimitError', () => {
  assert.deepEqual(Object.keys(errors), ['internalError', 'rateLimitError']);
  assert.equal(typeof errors.internalError, 'function');
  assert.equal(typeof errors.rateLimitError, 'function');
  assert.equal(errors.internalError('boom').code, 'internal_error');
  assert.equal(errors.rateLimitError('slow down').code, 'rate_limited');
});

test('FacilitatorError defaults to facilitator_error and its own name', () => {
  const err = new FacilitatorError('boom');

  assert.equal(err.code, 'facilitator_error');
  assert.equal(err.name, 'FacilitatorError');
  assert.ok(err instanceof Error);
});

test('InvalidRequestError pins invalid_request and its class name', () => {
  const err = new InvalidRequestError('bad request');

  assert.equal(err.code, 'invalid_request');
  assert.equal(err.name, 'InvalidRequestError');
  assert.ok(err instanceof FacilitatorError);
});

test('NotFoundError pins not_found and its class name', () => {
  const err = new NotFoundError('missing');

  assert.equal(err.code, 'not_found');
  assert.equal(err.name, 'NotFoundError');
  assert.ok(err instanceof FacilitatorError);
});

test('UnauthorizedError pins invalid_api_key and its class name', () => {
  const err = new UnauthorizedError('unauthorized');

  assert.equal(err.code, 'invalid_api_key');
  assert.equal(err.name, 'UnauthorizedError');
  assert.ok(err instanceof FacilitatorError);
});

test('RateLimitError pins rate_limited and its class name', () => {
  const err = new RateLimitError('slow down');

  assert.equal(err.code, 'rate_limited');
  assert.equal(err.name, 'RateLimitError');
  assert.ok(err instanceof FacilitatorError);
});

test('ServiceUnavailableError pins settlement_store_unavailable and its class name', () => {
  const err = new ServiceUnavailableError('store down');

  assert.equal(err.code, 'settlement_store_unavailable');
  assert.equal(err.name, 'ServiceUnavailableError');
  assert.ok(err instanceof FacilitatorError);
});

test('all six exported classes are errors of the expected shape', () => {
  const instances = [
    new FacilitatorError('x'),
    new InvalidRequestError('x'),
    new NotFoundError('x'),
    new UnauthorizedError('x'),
    new RateLimitError('x'),
    new ServiceUnavailableError('x'),
  ];

  for (const err of instances) {
    assert.ok(err instanceof Error);
    assert.ok(err instanceof FacilitatorError);
    assert.equal(typeof err.code, 'string');
    assert.ok(err.code.length > 0);
  }

  assert.deepEqual(
    instances.map(err => err.code),
    [
      'facilitator_error',
      'invalid_request',
      'not_found',
      'invalid_api_key',
      'rate_limited',
      'settlement_store_unavailable',
    ],
  );
});
