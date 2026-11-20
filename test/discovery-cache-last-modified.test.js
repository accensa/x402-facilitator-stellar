/**
 * #680: the Last-Modified validator must only be emitted for an instant the
 * catalog can actually date.
 *
 * `getLastModified()` belongs to the store, and a store is free to return the
 * timestamp in the shape its backing store persists: a `Date` (what the
 * in-memory store returns), epoch milliseconds, epoch seconds (what many
 * database drivers hand back), or an ISO-8601 string. Two of those produce a
 * header that can never match a newer representation:
 *
 *   - a non-date value became the literal `Invalid Date`, which is not a valid
 *     HTTP-date at all;
 *   - epoch seconds were read as milliseconds, dating the catalog to 1970, so
 *     every later `If-Modified-Since` looked newer and no client could ever
 *     revalidate.
 *
 * So `applyDiscoveryCache` coerces the value and, when the result is not a
 * finite instant, emits no `last-modified` header at all. The ETag and the 304
 * path are deliberately untouched by this fix and are covered by
 * test/discovery-cache-conditional.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscoveryCache } from '../src/catalog/discovery-cache.js';

/** The instant an epoch-seconds store would persist (2023-11-14T22:13:20Z). */
const INSTANT_SECONDS = 1_700_000_000;

/** The same instant as epoch milliseconds. */
const INSTANT_MS = INSTANT_SECONDS * 1000;

/** The same instant as an ISO-8601 string. */
const INSTANT_ISO = new Date(INSTANT_MS).toISOString();

/** The HTTP-date every representation of the instant above must produce. */
const INSTANT_HTTP = new Date(INSTANT_MS).toUTCString();

/** Minimal Fastify stand-ins: only the surface applyDiscoveryCache touches. */
function fakeReply() {
  const headers = {};
  return {
    headers,
    header(name, value) {
      headers[name] = value;
    },
  };
}

/**
 * Applies the discovery cache headers against a catalog whose validator is
 * `lastModified`, optionally with an If-Modified-Since precondition.
 *
 * @param {unknown} lastModified
 * @param {Record<string, string>} [requestHeaders={}]
 * @returns {{ headers: Record<string, string>, notModified: boolean }}
 */
function callWith(lastModified, requestHeaders = {}) {
  const reply = fakeReply();
  const { notModified } = applyDiscoveryCache(
    { headers: requestHeaders, method: 'GET' },
    reply,
    { getVersion: () => 1, getLastModified: () => lastModified },
    undefined,
    {},
  );
  return { headers: reply.headers, notModified };
}

test('#680: a Date is emitted as its HTTP-date', () => {
  const { headers } = callWith(new Date(INSTANT_MS));
  assert.equal(headers['last-modified'], INSTANT_HTTP);
});

test('#680: epoch milliseconds are emitted as their HTTP-date', () => {
  const { headers } = callWith(INSTANT_MS);
  assert.equal(headers['last-modified'], INSTANT_HTTP);
});

test('#680: epoch seconds are read as seconds, so the catalog is dated 2023, not 1970', () => {
  const { headers } = callWith(INSTANT_SECONDS);
  assert.equal(headers['last-modified'], INSTANT_HTTP);
  assert.doesNotMatch(
    headers['last-modified'],
    /1970/,
    'reading seconds as milliseconds would date a 2023 instant to Jan 1970',
  );
});

test('#680: an ISO-8601 string is parsed into its HTTP-date', () => {
  const { headers } = callWith(INSTANT_ISO);
  assert.equal(headers['last-modified'], INSTANT_HTTP);
});

test('#680: a non-date string emits no header and answers an ordinary 200', () => {
  const { headers, notModified } = callWith('not-a-date', {
    'if-modified-since': INSTANT_HTTP,
  });
  assert.equal(headers['last-modified'], undefined, 'an invalid date must not be emitted');
  assert.ok(headers.etag, 'the ETag is unaffected by an undatable last-modified');
  assert.equal(
    notModified,
    false,
    'a store with no usable last-modified cannot satisfy If-Modified-Since',
  );
});

test('#680: a plain object emits no header', () => {
  const { headers } = callWith({});
  assert.equal(headers['last-modified'], undefined);
});

test('#680: null and undefined emit no header', () => {
  assert.equal(callWith(null).headers['last-modified'], undefined);
  assert.equal(callWith(undefined).headers['last-modified'], undefined);
});

test('#680: an Invalid Date emits no header instead of "Invalid Date"', () => {
  const { headers } = callWith(new Date('nope'));
  assert.equal(headers['last-modified'], undefined);
});

test('#680: a non-finite number emits no header', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(
      callWith(value).headers['last-modified'],
      undefined,
      `expected no header for ${value}`,
    );
  }
});

test('#680: a catalog without getLastModified emits no header', () => {
  const reply = fakeReply();
  applyDiscoveryCache(
    { headers: {}, method: 'GET' },
    reply,
    { getVersion: () => 1 },
    undefined,
    {},
  );
  assert.equal(reply.headers['last-modified'], undefined);
  assert.ok(reply.headers.etag, 'the ETag is still produced');
});
