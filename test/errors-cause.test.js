import test from 'node:test';
import assert from 'node:assert/strict';
import { FacilitatorError, InvalidRequestError, ServiceUnavailableError } from '../src/errors.js';

test('the wrapped error is reachable from FacilitatorError.cause', () => {
  const original = new Error('database unavailable');
  const err = new FacilitatorError('x', { cause: original });
  assert.equal(err.cause, original);
});

test('a subclass preserves cause and settlement_store_unavailable code', () => {
  const original = new Error('down');
  const err = new ServiceUnavailableError('down', null, original);
  assert.equal(err.cause, original);
  assert.equal(err.code, 'settlement_store_unavailable');
});

test('existing two-argument subclass calls remain compatible', () => {
  const err = new InvalidRequestError('bad body', { field: 'paymentPayload' });
  assert.equal(err.code, 'invalid_request');
  assert.deepEqual(err.context, { field: 'paymentPayload' });
  assert.equal(Object.prototype.hasOwnProperty.call(err, 'cause'), false);
});

test('an omitted or undefined cause introduces no unexpected behavior', () => {
  const omitted = new FacilitatorError('x');
  const explicit = new FacilitatorError('x', { cause: undefined });
  assert.equal(Object.prototype.hasOwnProperty.call(omitted, 'cause'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(explicit, 'cause'), false);
});
