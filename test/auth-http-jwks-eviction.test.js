/**
 * The JWKS cache is bounded at ten entries (#663).
 *
 * `JwksCache.set` evicts `this.cache.keys().next().value` — the oldest
 * insertion — once the map is full. Nothing exercised that path, so a wrong
 * eviction key would have been silent. This test drives eleven distinct
 * issuers through the public verifier interface, counts the stubbed fetches
 * per URL, and proves the first issuer is the victim while the tenth and
 * eleventh stay cached.
 *
 * No real network request is made. `jose` 5 fetches over `node:https` on
 * Node, so this test redirects `https.get` into a stubbed `globalThis.fetch`;
 * every request is counted and answered by that stub, and both are restored in
 * `t.after`. `jose` snapshots `https.get` when it is first evaluated, which is
 * why the verifier is imported dynamically after the redirect is installed.
 * Only `https://issuer.invalid/...` URLs are accepted, so a leak to the real
 * network fails the test instead of resolving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

// Load node:https through CJS so the redirect below is installed before any ESM
// namespace for it exists; jose's `import * as https` then snapshots the stub.
const require = createRequire(import.meta.url);
const https = require('node:https');

const ISSUER_COUNT = 11;

test('the JWKS cache evicts the first of eleven issuers', async t => {
  const uris = Array.from(
    { length: ISSUER_COUNT },
    (_, index) => `https://issuer.invalid/issuer-${index + 1}/jwks.json`,
  );
  const fetchCounts = new Map(uris.map(uri => [uri, 0]));

  const originalFetch = globalThis.fetch;
  const originalGet = https.get;
  t.after(() => {
    globalThis.fetch = originalFetch;
    https.get = originalGet;
  });

  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;
    assert.ok(fetchCounts.has(url), `unexpected fetch to ${url}`);
    fetchCounts.set(url, fetchCounts.get(url) + 1);
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  // Route jose's node:https reads through the stub above; it never opens a
  // socket. jose awaits a 'response' event and then reads the body as a stream.
  https.get = (href, options = {}) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    globalThis
      .fetch(href, { headers: options.headers })
      .then(async response => {
        const stream = Readable.from([Buffer.from(await response.text())]);
        stream.statusCode = response.status;
        stream.headers = Object.fromEntries(response.headers);
        request.emit('response', stream);
      })
      .catch(error => request.emit('error', error));
    return request;
  };

  const { exportJWK, generateKeyPair, SignJWT } = await import('jose');
  const { createJwtVerifier } = await import('../src/auth-http.js');

  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'eviction-key';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';

  const token = await new SignJWT({ scope: 'read' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'eviction-key' })
    .setSubject('test-user')
    .setExpirationTime('5m')
    .sign(privateKey);

  const verifiers = uris.map(uri => createJwtVerifier(uri));

  // Insert all eleven issuers in order. The eleventh insertion must evict the
  // first, which is the oldest entry in insertion order.
  for (let index = 0; index < ISSUER_COUNT; index++) {
    await verifiers[index].verifyToken(token);
  }
  for (const uri of uris) {
    assert.equal(fetchCounts.get(uri), 1, `${uri} should be fetched exactly once`);
  }

  // The first issuer was evicted, so verifying it again refetches its JWKS.
  await verifiers[0].verifyToken(token);
  assert.equal(fetchCounts.get(uris[0]), 2, 'the first issuer should be evicted and refetched');

  // The tenth and eleventh issuers are still cached: no additional fetch.
  await verifiers[9].verifyToken(token);
  await verifiers[10].verifyToken(token);
  assert.equal(fetchCounts.get(uris[9]), 1, 'the tenth issuer should still be cached');
  assert.equal(fetchCounts.get(uris[10]), 1, 'the eleventh issuer should still be cached');

  assert.deepEqual(
    uris.map(uri => fetchCounts.get(uri)),
    [2, ...Array(ISSUER_COUNT - 1).fill(1)],
  );
});
