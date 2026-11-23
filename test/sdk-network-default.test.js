import test from 'node:test';
import assert from 'node:assert/strict';
import { createStellarDiscoveryResource } from '../src/sdk/index.js';

/**
 * Network-default regression protection (#698).
 *
 * `createStellarDiscoveryResource` used `params.network || 'stellar:testnet'`,
 * so an empty network string — typically an unset environment variable — was
 * silently replaced with testnet. Only an omitted (undefined/null) network may
 * default; an explicitly empty or non-string network must fail validation.
 */

function declaration(network) {
  return {
    routeTemplate: '/api/ping',
    pricing: { amount: '1', asset: 'XLM' },
    ...(network === undefined ? {} : { network }),
  };
}

test('an omitted network defaults to stellar:testnet', () => {
  const resource = createStellarDiscoveryResource(declaration(undefined));
  assert.equal(resource.network, 'stellar:testnet');
});

test('a null network defaults to stellar:testnet', () => {
  const resource = createStellarDiscoveryResource(declaration(null));
  assert.equal(resource.network, 'stellar:testnet');
});

test('an explicit network is preserved as passed', () => {
  const resource = createStellarDiscoveryResource(declaration('stellar:pubnet'));
  assert.equal(resource.network, 'stellar:pubnet');
});

test('an empty network string throws instead of defaulting to testnet', () => {
  assert.throws(
    () => createStellarDiscoveryResource(declaration('')),
    /Invalid discovery declaration:[\s\S]*network must be a non-empty string when provided/,
  );
});

test('a non-string network throws a validation error', () => {
  for (const network of [42, true, {}, ['stellar:pubnet']]) {
    assert.throws(
      () => createStellarDiscoveryResource(declaration(network)),
      /Invalid discovery declaration:[\s\S]*network must be a non-empty string when provided/,
      `expected ${String(network)} (${typeof network}) to be rejected`,
    );
  }
});

test('an undefined network does not add a network validation error', () => {
  // Guard against the empty-string check accidentally firing for omission.
  assert.doesNotThrow(() => createStellarDiscoveryResource(declaration(undefined)));
  assert.doesNotThrow(() => createStellarDiscoveryResource(declaration(null)));
});
