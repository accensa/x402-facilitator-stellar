/**
 * The remote key source must prove it sent JSON before we parse it (#659).
 *
 * `loadRemoteKeys` used to call `response.json()` unconditionally after a 200.
 * A proxy or captive portal answering HTML then failed with a bare
 * `Unexpected token '<'` — no URL, no status, no clue which source was
 * misconfigured. These tests stub `fetch` (no network, no server) and pin the
 * four paths the issue calls out: HTML rejected, malformed JSON rejected, a
 * `charset` parameter accepted, and the pre-existing shape wording unchanged.
 * The response body must never appear in an error message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRemoteKeys } from '../src/facilitator.js';

const URL_UNDER_TEST = 'http://127.0.0.1:9/key-source';
const SECRET = 'SAO2MAIQCR5T27QDICO3QJTD2YZ4PMEAVLCLQ6AANVGPCZ53TEACPDOQ';

/** Replaces global fetch for the duration of `fn`, always restoring it. */
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** A Response-like stub: `loadRemoteKeys` only reads `ok`, `status`, headers and json(). */
function reply({ status = 200, contentType, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => (name?.toLowerCase() === 'content-type' ? (contentType ?? null) : null),
    },
    json: async () => {
      if (typeof body === 'string') return JSON.parse(body);
      return body;
    },
  };
}

test('an HTML key source names the URL and content type, not the body (#659)', async () => {
  const handler = async () =>
    reply({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html>maintenance</html>',
    });
  await withFetch(handler, async () => {
    await assert.rejects(
      () => loadRemoteKeys(URL_UNDER_TEST, 2000),
      err => {
        assert.match(err.message, /key source http:\/\/127\.0\.0\.1:9\/key-source/);
        assert.match(err.message, /text\/html/);
        assert.equal(err.message.includes('<html>'), false, 'must not echo the body');
        assert.equal(err.message.includes('maintenance'), false, 'must not echo the body');
        return true;
      },
    );
  });
});

test('a JSON content type with a malformed body names the URL (#659)', async () => {
  const handler = async () =>
    reply({ status: 200, contentType: 'application/json', body: '{"keys": [' });
  await withFetch(handler, async () => {
    await assert.rejects(
      () => loadRemoteKeys(URL_UNDER_TEST, 2000),
      err => {
        assert.match(err.message, /key source http:\/\/127\.0\.0\.1:9\/key-source/);
        assert.match(err.message, /invalid JSON/);
        assert.equal(err.message.includes('{"keys"'), false, 'must not echo the body');
        assert.equal(err.message.includes('Unexpected'), false, 'must not surface the parser text');
        return true;
      },
    );
  });
});

test('application/json with a charset parameter is still accepted (#659)', async () => {
  const handler = async () =>
    reply({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ keys: [SECRET] }),
    });
  await withFetch(handler, async () => {
    assert.deepEqual(await loadRemoteKeys(URL_UNDER_TEST, 2000), [SECRET]);
  });
});

test('the shape-error wording is unchanged (#659)', async () => {
  const handler = async () =>
    reply({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ wrong: [] }),
    });
  await withFetch(handler, async () => {
    await assert.rejects(() => loadRemoteKeys(URL_UNDER_TEST, 2000), /missing "keys" field/);
  });
});
