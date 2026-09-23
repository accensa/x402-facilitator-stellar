/**
 * Client-IP pseudonymisation (#204).
 *
 * docs/PRIVACY.md promises raw IP addresses are not retained. These tests pin
 * the mechanism that makes that true: the helper's determinism (so rate
 * limiting still works) and the end-to-end guarantee that a real rate-limit
 * bucket and a real audit record contain a pseudonym, never the address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pseudonymizeIp, createIpPseudonymizer, deriveIpHashSecret } from '../src/ip.js';
import { RateLimiter } from '../src/rate-limit.js';
import { serve, testConfig, stubFacilitator, stubCatalog, VALID_BODY } from './helpers/app.js';

test('pseudonymizeIp is stable, hex-shaped, and never returns the address', () => {
  const ip = '203.0.113.7';
  const first = pseudonymizeIp(ip);
  const second = pseudonymizeIp(ip);

  assert.equal(first, second, 'the same address must key the same bucket');
  assert.match(first, /^[0-9a-f]{24}$/, 'a 12-byte digest, hex-encoded');
  assert.equal(first.includes(ip), false);
  assert.notEqual(first, ip);
});

test('different addresses map to different pseudonyms', () => {
  assert.notEqual(pseudonymizeIp('203.0.113.7'), pseudonymizeIp('198.51.100.9'));
});

test('a keyed pseudonym differs from the unkeyed fallback, and the key is stable', () => {
  const key = deriveIpHashSecret('SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW');
  assert.ok(key, 'a signer secret must derive a key');
  assert.deepEqual(
    key,
    deriveIpHashSecret('SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW'),
    'derivation is deterministic so replicas agree',
  );
  const keyed = createIpPseudonymizer({ secret: key })('203.0.113.7');
  assert.notEqual(keyed, pseudonymizeIp('203.0.113.7'));
  assert.match(keyed, /^[0-9a-f]{24}$/);
  assert.equal(deriveIpHashSecret(undefined), null);
});

test('absent addresses stay absent (no shared bucket is invented)', () => {
  assert.equal(pseudonymizeIp(undefined), undefined);
  assert.equal(pseudonymizeIp(null), null);
  assert.equal(pseudonymizeIp(''), '');
});

test('rate-limit buckets and audit actors contain a pseudonym, not the client IP', async () => {
  const limiter = new RateLimiter({
    global: { verifyRpm: 1, settleRpm: 10, settleRph: 100, settleRpd: 1000, feeSpd: 1e9 },
    keys: {},
  });
  const audit = [];
  const app = await serve({
    config: { ...testConfig(), trustProxy: 1 },
    facilitator: stubFacilitator(),
    rateLimiter: limiter,
    catalog: stubCatalog(),
    // createApp's audit override is `(event, fields) => void`, not a JSON sink.
    extras: { audit: (event, fields) => audit.push({ event, ...fields }) },
  });

  const clientA = '203.0.113.7';
  const clientB = '198.51.100.9';
  try {
    const a1 = await app.post('/verify', VALID_BODY, { 'x-forwarded-for': clientA });
    assert.ok(a1.status !== 429, `client A first request should pass, got ${a1.status}`);
    // Second from A is out of budget — and produces the audit record below.
    const a2 = await app.post('/verify', VALID_BODY, { 'x-forwarded-for': clientA });
    assert.equal(a2.status, 429);
    // B lands in its own bucket.
    const b1 = await app.post('/verify', VALID_BODY, { 'x-forwarded-for': clientB });
    assert.ok(b1.status !== 429, `client B should have its own bucket, got ${b1.status}`);
  } finally {
    await app.close();
  }

  const bucketIds = [...limiter.store.map.keys()];
  assert.ok(bucketIds.length >= 2, 'both callers were bucketed');
  for (const id of bucketIds) {
    assert.equal(id.includes(clientA), false, `raw IP leaked into bucket: ${id}`);
    assert.equal(id.includes(clientB), false, `raw IP leaked into bucket: ${id}`);
  }
  const owners = new Set(bucketIds.map(id => id.split(':')[0]));
  assert.equal(owners.size, 2, 'the two addresses must not collapse into one bucket');

  const rejected = audit.find(record => record.event === 'rate_limit_rejected');
  assert.ok(rejected, 'the rejection must be audited');
  assert.match(rejected.actor, /^ip:[0-9a-f]{24}$/);
  assert.equal(
    JSON.stringify(audit).includes(clientA),
    false,
    'raw IP leaked into an audit record',
  );
});

test('the privacy docs describe the pseudonymisation, not the old false claim', () => {
  const privacy = readFileSync(new URL('../docs/PRIVACY.md', import.meta.url), 'utf8');
  assert.equal(
    privacy.includes('Not retained beyond transient rate-limiting memory windows'),
    false,
    'PRIVACY.md must not keep the claim the code contradicted',
  );
  assert.match(privacy, /pseudonym/i);

  const audit = readFileSync(new URL('../docs/AUDIT.md', import.meta.url), 'utf8');
  assert.match(audit, /ip:<pseudonym>/, 'AUDIT.md must document the pseudonymous actor');
});
