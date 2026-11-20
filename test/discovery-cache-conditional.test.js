/**
 * #687: complete RFC 9110 conditional request handling for discovery.
 *
 * The discovery routes advertise a weak ETag and a Last-Modified date, so they
 * must accept both validators the way a conforming cache or proxy sends them:
 * exact string equality alone never accepts `*`, never applies weak comparison
 * (so a client echoing the strong form of the same tag re-fetched), and never
 * reads If-Modified-Since at all. Precedence lives here in one place so the
 * three routes cannot drift apart.
 *
 * The table below is the contract from RFC 9110 §13.2.2:
 *
 * | If-None-Match      | If-Modified-Since      | Result |
 * | ------------------ | ---------------------- | ------ |
 * | absent             | absent                 | 200    |
 * | exact tag          | —                      | 304    |
 * | strong form of tag | —                      | 304    |
 * | weak form of tag   | —                      | 304    |
 * | `*`                | —                      | 304    |
 * | different tag      | matching date          | 200 (Inm wins, Ims ignored) |
 * | absent             | equal/later date       | 304    |
 * | absent             | earlier date           | 200    |
 * | absent             | malformed date         | 200    |
 * | non-GET/HEAD       | —                      | 200    |
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscoveryCache, discoveryETag } from '../src/catalog/discovery-cache.js';

const VERSION = 7;
const LAST_MODIFIED = Date.parse('2026-08-01T00:00:00Z');
const LAST_MODIFIED_HTTP = new Date(LAST_MODIFIED).toUTCString();
const ETAG = discoveryETag(VERSION, {});

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

function fakeCatalog(overrides = {}) {
  return {
    getVersion: () => VERSION,
    getLastModified: () => LAST_MODIFIED,
    ...overrides,
  };
}

function call(headers = {}, { method = 'GET', catalog = fakeCatalog() } = {}) {
  const reply = fakeReply();
  const result = applyDiscoveryCache({ headers, method }, reply, catalog, undefined, {});
  return { ...result, headers: reply.headers };
}

test('#687: conditional request table', async t => {
  const rows = [
    ['no preconditions', {}, 200],
    ['exact etag', { 'if-none-match': ETAG }, 304],
    ['strong form of the same tag', { 'if-none-match': ETAG.slice(2) }, 304],
    ['the published weak tag', { 'if-none-match': `W/${ETAG.slice(2)}` }, 304],
    ['wildcard', { 'if-none-match': '*' }, 304],
    ['a different tag', { 'if-none-match': 'W/"7-other"' }, 200],
    ['a list containing the tag', { 'if-none-match': `W/"x", ${ETAG} , W/"y"` }, 304],
    ['a list without the tag', { 'if-none-match': 'W/"x", W/"y"' }, 200],
    [
      'tag mismatch beats a matching date',
      { 'if-none-match': 'W/"nope"', 'if-modified-since': LAST_MODIFIED_HTTP },
      200,
    ],
    [
      'wildcard beats any date',
      { 'if-none-match': '*', 'if-modified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' },
      304,
    ],
    ['date equal to last-modified', { 'if-modified-since': LAST_MODIFIED_HTTP }, 304],
    [
      'date after last-modified',
      { 'if-modified-since': new Date(LAST_MODIFIED + 86_400_000).toUTCString() },
      304,
    ],
    [
      'date before last-modified',
      { 'if-modified-since': new Date(LAST_MODIFIED - 86_400_000).toUTCString() },
      200,
    ],
    ['malformed date is ignored', { 'if-modified-since': 'not a date' }, 200],
    ['empty if-none-match is not a match', { 'if-none-match': '' }, 200],
  ];

  for (const [name, headers, expected] of rows) {
    await t.test(name, () => {
      const { notModified } = call(headers);
      assert.equal(notModified, expected === 304, `${name} must be a ${expected}`);
    });
  }
});

test('#687: opaque tags are compared case-sensitively after stripping only W/', () => {
  // A lettered catalog version makes the case difference explicit in the tag.
  const catalog = fakeCatalog({ getVersion: () => 'V7' });
  const etag = discoveryETag('V7', {});

  assert.equal(call({ 'if-none-match': etag }, { catalog }).notModified, true);
  assert.equal(
    call({ 'if-none-match': 'W/"v7-' + etag.slice('W/"V7-'.length) }, { catalog }).notModified,
    false,
    'a tag differing only in case is a different tag',
  );
});

test('#687: HEAD is conditional, other methods are not', async t => {
  await t.test('HEAD with the tag gets 304', () => {
    assert.equal(call({ 'if-none-match': ETAG }, { method: 'HEAD' }).notModified, true);
  });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await t.test(`${method} never yields a 304`, () => {
      assert.equal(call({ 'if-none-match': ETAG }, { method }).notModified, false);
      assert.equal(
        call({ 'if-modified-since': LAST_MODIFIED_HTTP }, { method }).notModified,
        false,
      );
    });
  }
});

test('#687: a 304 keeps every validator and the cache policy', () => {
  const { notModified, headers } = call({ 'if-none-match': ETAG });
  assert.equal(notModified, true);
  assert.match(
    headers['cache-control'],
    /^public, max-age=\d+, stale-while-revalidate=\d+$/,
    'the 304 still tells the cache how long it may reuse the representation',
  );
  assert.equal(headers.etag, ETAG);
  assert.equal(headers['last-modified'], LAST_MODIFIED_HTTP);
});

test('#687: If-Modified-Since without a last-modified validator cannot 304', () => {
  const catalog = fakeCatalog({ getLastModified: () => null });
  const { notModified, headers } = call({ 'if-modified-since': LAST_MODIFIED_HTTP }, { catalog });
  assert.equal(notModified, false);
  assert.equal(headers['last-modified'], undefined);
});
