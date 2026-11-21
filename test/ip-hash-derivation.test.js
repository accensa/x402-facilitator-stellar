/**
 * The IP pseudonym is a persisted rate-limit bucket id (#661, #204).
 *
 * `pseudonymizeIp` hashes the address, and `deriveIpHashSecret` keys that hash
 * from `sha256("x402:ip-pseudonym:v1:" + signerSecret)`. Both are intentionally
 * stable: a refactor of the label, the algorithm or the 12-byte truncation
 * would silently re-key every bucket on the next deploy, resetting in-flight
 * windows and merging callers that used to be separate. This suite pins the
 * exact values with a fixed, documented-range secret and address so such a
 * change fails a test instead of quietly shipping. It is a characterisation
 * test only: no production code is touched.
 *
 * Digests are written as literals, computed from the construction documented in
 * `src/ip.js`, not read back from the implementation under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pseudonymizeIp, deriveIpHashSecret } from '../src/ip.js';

// A fixed, real ed25519-seed-shaped secret. It keys the derivation below; it is
// a fixture, never a deployed key, and the values it produces are public here.
const SIGNER_SECRET = 'SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW';

// Documentation-range addresses (RFC 5737 / RFC 3849), so no real caller is pinned.
const IPV4 = '203.0.113.7';
const OTHER_IPV4 = '198.51.100.9';
const IPV6 = '2001:db8::1';

// sha256("x402:ip-pseudonym:v1:" + SIGNER_SECRET), full 32 bytes.
const DERIVED_KEY_HEX = '07cf5e01638c93238d90564d737da930bc2daa60c282f9154e59fc702100812b';
// HMAC-SHA-256(DERIVED_KEY_HEX, "203.0.113.7"), first 12 bytes.
const KEYED_DIGEST = '6cb67e7053d49e6bb27f8324';
// HMAC-SHA-256(DERIVED_KEY_HEX, "198.51.100.9"), first 12 bytes.
const KEYED_DIGEST_OTHER = '44fd2538914bca2695b647c5';
// HMAC-SHA-256(DERIVED_KEY_HEX, "2001:db8::1"), first 12 bytes.
const KEYED_DIGEST_IPV6 = '53df31b44a708a7b95f4105c';
// sha256("203.0.113.7"), first 12 bytes — the unkeyed fallback.
const UNKEYED_DIGEST = 'fec52565aa0cf18f57d7cf5b';

test('the derived HMAC key is pinned to its documented construction (#661)', () => {
  const key = deriveIpHashSecret(SIGNER_SECRET);
  assert.ok(Buffer.isBuffer(key), 'a signer secret must derive a Buffer key');
  assert.equal(key.toString('hex'), DERIVED_KEY_HEX);
  assert.equal(
    key.toString('hex'),
    crypto.createHash('sha256').update(`x402:ip-pseudonym:v1:${SIGNER_SECRET}`).digest('hex'),
    'the domain-separated label must not change',
  );
  // Stability across calls is what lets replicas agree on a bucket.
  assert.deepEqual(deriveIpHashSecret(SIGNER_SECRET), key);
});

test('a keyed address produces the literal 24-character digest (#661)', () => {
  const key = deriveIpHashSecret(SIGNER_SECRET);
  const digest = pseudonymizeIp(IPV4, { secret: key });

  assert.equal(digest, KEYED_DIGEST);
  assert.match(digest, /^[0-9a-f]{24}$/, '12 bytes truncated, hex-encoded');
  assert.notEqual(digest, IPV4);
});

test('different keyed addresses stay in different buckets (#661)', () => {
  const key = deriveIpHashSecret(SIGNER_SECRET);
  assert.equal(pseudonymizeIp(OTHER_IPV4, { secret: key }), KEYED_DIGEST_OTHER);
  assert.equal(pseudonymizeIp(IPV6, { secret: key }), KEYED_DIGEST_IPV6);
  assert.notEqual(KEYED_DIGEST, KEYED_DIGEST_OTHER);
});

test('the unkeyed fallback is a SHA-256 prefix and differs from the keyed digest (#661)', () => {
  const digest = pseudonymizeIp(IPV4);
  assert.equal(digest, UNKEYED_DIGEST);
  assert.equal(digest, crypto.createHash('sha256').update(IPV4).digest('hex').slice(0, 24));
  assert.notEqual(digest, KEYED_DIGEST, 'a key must change the bucket id');
});

test('invalid inputs are pinned: absent addresses are not bucketed (#661)', () => {
  // An absent address must not be given a shared "undefined" bucket…
  assert.equal(pseudonymizeIp(undefined), undefined);
  assert.equal(pseudonymizeIp(null), null);
  assert.equal(pseudonymizeIp(''), undefined);

  // …and an unusable signer secret must not derive a key from garbage.
  assert.equal(deriveIpHashSecret(undefined), null);
  assert.equal(deriveIpHashSecret(null), null);
  assert.equal(deriveIpHashSecret(''), null);
  assert.equal(deriveIpHashSecret(42), null);
});
