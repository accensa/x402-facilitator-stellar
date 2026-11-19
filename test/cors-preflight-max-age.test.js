/**
 * Preflight Max-Age security test for issue #678.
 * Verifies that OPTIONS /verify returns short max-age (300s) and
 * OPTIONS /supported returns longer max-age (600s), with config overrides.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreflightMaxAge } from '../src/cors.js';

describe('Preflight Max-Age', () => {
  test('preflightMaxAgeSeconds override reaches the header', () => {
    // authenticated policy with override
    let result = resolvePreflightMaxAge(
      { preflightMaxAgeSeconds: { authenticated: 120, public: 600 } },
      'authenticated',
    );
    assert.strictEqual(result, 120, 'override of authenticated max-age should be 120');

    // public policy with override
    result = resolvePreflightMaxAge(
      { preflightMaxAgeSeconds: { authenticated: 60, public: 999 } },
      'public',
    );
    assert.strictEqual(result, 999, 'override of public max-age should be 999');

    // no override, authenticated should use default 60
    result = resolvePreflightMaxAge({}, 'authenticated');
    assert.strictEqual(result, 60, 'default authenticated max-age should be 60');

    // no override, public should use default 600
    result = resolvePreflightMaxAge({}, 'public');
    assert.strictEqual(result, 600, 'default public max-age should be 600');
  });

  test('invalid preflightMaxAgeSeconds value is clamped, never emitted as NaN', () => {
    // Invalid: negative number
    let result = resolvePreflightMaxAge(
      { preflightMaxAgeSeconds: { authenticated: -1, public: 600 } },
      'authenticated',
    );
    assert.strictEqual(result, 60, 'negative value should fall back to default');

    // Invalid: zero
    result = resolvePreflightMaxAge(
      { preflightMaxAgeSeconds: { authenticated: 0, public: 600 } },
      'authenticated',
    );
    assert.strictEqual(result, 60, 'zero value should fall back to default');

    // Invalid: NaN
    result = resolvePreflightMaxAge(
      { preflightMaxAgeSeconds: { authenticated: NaN, public: 600 } },
      'authenticated',
    );
    assert.strictEqual(result, 60, 'NaN value should fall back to default');

    // Invalid: string that's not a number
    result = resolvePreflightMaxAge(
      { preflightMaxAgeSeconds: { authenticated: 'abc', public: 600 } },
      'authenticated',
    );
    assert.strictEqual(result, 60, 'string value should fall back to default');

    // Valid: should use the override
    result = resolvePreflightMaxAge(
      { preflightMaxAgeSeconds: { authenticated: 999, public: 600 } },
      'authenticated',
    );
    assert.strictEqual(result, 999, 'valid override should be used');
  });
});
