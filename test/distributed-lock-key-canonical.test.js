/**
 * Canonical lock-key derivation (#709).
 *
 * A lock key must depend on a payment object's content, not on the order its
 * properties happened to be inserted. Replicas that build the same object in a
 * different order must derive the same key or they serialize against different
 * locks. Arrays are ordered values, so their element order must still matter.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lockKeyFor } from '../src/distributed-lock.js';

describe('lockKeyFor canonical JSON', () => {
  test('flat objects with permuted keys derive the same key', () => {
    assert.equal(lockKeyFor({ a: 1, b: 2 }), lockKeyFor({ b: 2, a: 1 }));
    assert.equal(
      lockKeyFor({ scheme: 'exact', network: 'stellar:testnet', amount: '1000' }),
      lockKeyFor({ amount: '1000', scheme: 'exact', network: 'stellar:testnet' }),
    );
  });

  test('deeply nested objects with permuted keys derive the same key', () => {
    const one = {
      scheme: 'exact',
      payload: { transaction: 'AAAA', authorization: { from: 'G1', to: 'G2' } },
    };
    const two = {
      payload: { authorization: { to: 'G2', from: 'G1' }, transaction: 'AAAA' },
      scheme: 'exact',
    };
    assert.equal(lockKeyFor(one), lockKeyFor(two));
  });

  test('arrays preserve element order', () => {
    assert.notEqual(lockKeyFor([1, 2]), lockKeyFor([2, 1]));
    assert.notEqual(lockKeyFor({ items: [1, 2] }), lockKeyFor({ items: [2, 1] }));
  });

  test('objects inside arrays have their keys canonicalized', () => {
    assert.equal(lockKeyFor([{ a: 1, b: 2 }]), lockKeyFor([{ b: 2, a: 1 }]));
    assert.equal(
      lockKeyFor({ items: [{ x: { a: 1, b: 2 } }, { c: 3, d: 4 }] }),
      lockKeyFor({ items: [{ x: { b: 2, a: 1 } }, { d: 4, c: 3 }] }),
    );
  });

  test('primitives, null, and undefined are handled gracefully', () => {
    for (const value of ['payment', 42, true, null, undefined]) {
      const key = lockKeyFor(value);
      assert.match(key, /^settle:[0-9a-f]{64}$/);
      assert.equal(key, lockKeyFor(value));
    }

    assert.equal(lockKeyFor(undefined), lockKeyFor(null));
  });

  test('undefined object properties are omitted like JSON.stringify', () => {
    assert.equal(lockKeyFor({ a: 1, b: undefined }), lockKeyFor({ a: 1 }));
    assert.equal(lockKeyFor([1, undefined, 2]), lockKeyFor([1, null, 2]));
  });
});
