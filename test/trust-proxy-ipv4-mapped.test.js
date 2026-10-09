/**
 * IPv4-mapped IPv6 trust-subnet regression (issue #488).
 *
 * GHSA-jqcg-44mw-7w3h / CVE-2026-90711 (proxy-addr < 2.0.8, critical) is a
 * misconfiguration-shaped bug: a trust subnet written as `::ffff:10.0.0.0/8`
 * — the correct spelling is `/104` — compiled with all-zero leading bits and
 * matched EVERY IPv4 address. Every unauthenticated client was then believed
 * to be a trusted proxy at hop 0, so `req.ip` became whatever the client sent
 * in `X-Forwarded-For`, which defeats the IP-keyed rate limiter, the audit
 * trail and any IP-based allow-list. The config is accepted without an error,
 * so nothing about the mistake is visible from the operator's side.
 *
 * The vulnerable package is not on this service's request path: `proxy-addr`
 * is reached only through `express@5.2.1`, which is a devDependency used by
 * `examples/http-seller/index.js` and `scripts/e2e*.mjs`. The server is
 * Fastify, and client-IP resolution is this repo's own implementation
 * (`src/trust-proxy.js`, installed by `src/app.js` ahead of `src/ip.js`).
 *
 * These tests pin that implementation against the same shapes, in both
 * directions: a short-prefix mapped subnet must not widen the trust boundary,
 * and the spellings that are correct must keep working — because the failure
 * mode of over-correcting there is that a dual-stack IPv4 peer stops matching
 * its own IPv4 range, every caller behind it collapses into one bucket, and
 * the limiter starts throttling the whole deployment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientIp } from '../src/trust-proxy.js';

/**
 * @param {string} peer - the TCP peer address
 * @param {string|undefined} xff - the X-Forwarded-For header value
 * @returns {object} a request shaped the way `resolveClientIp` reads it
 */
function request(peer, xff) {
  return {
    socket: { remoteAddress: peer },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  };
}

test('a mapped IPv4 subnet with a short prefix does not believe X-Forwarded-For', () => {
  // 203.0.113.7 is outside 10.0.0.0/8, which is what `::ffff:10.0.0.0/8` is
  // meant to name. proxy-addr < 2.0.8 matched it anyway; the peer must stay
  // untrusted here, which discards the header and resolves the peer.
  assert.equal(
    resolveClientIp(request('203.0.113.7', '198.51.100.9'), ['::ffff:10.0.0.0/8']),
    '203.0.113.7',
  );
});

test('a zero-leading-bits IPv6 range does not match IPv4 addressees', () => {
  // The other shape the advisory calls out: `::/1` matching everything.
  assert.equal(resolveClientIp(request('203.0.113.7', '198.51.100.9'), ['::/1']), '203.0.113.7');
});

test('an IPv4-mapped peer still matches a plain IPv4 trust subnet', () => {
  // A dual-stack socket reports an IPv4 peer as `::ffff:a.b.c.d`. The trusted
  // proxy has to stay trusted, so the client it forwarded for is resolved.
  assert.equal(
    resolveClientIp(request('::ffff:10.0.0.1', '198.51.100.9'), ['10.0.0.0/8']),
    '198.51.100.9',
  );
});

test('the correctly spelled mapped subnet still matches its own block', () => {
  // `::ffff:10.0.0.0/104` is the honest way to write 10.0.0.0/8 in IPv6
  // notation: the prefix covers the ffff marker.
  assert.equal(
    resolveClientIp(request('::ffff:10.0.0.1', '198.51.100.9'), ['::ffff:10.0.0.0/104']),
    '198.51.100.9',
  );
});

test('a mapped X-Forwarded-For entry is not skipped as a trusted hop', () => {
  // The peer is trusted, so the walk moves to the forwarded entry. That entry
  // is inside no trusted range, so the walk stops and it becomes the resolved
  // client — the vouched-for value from the trusted proxy, not a hop the
  // limiter should have ignored.
  assert.equal(
    resolveClientIp(request('::ffff:10.0.0.1', '::ffff:203.0.113.7'), ['10.0.0.0/8']),
    '::ffff:203.0.113.7',
  );
});
