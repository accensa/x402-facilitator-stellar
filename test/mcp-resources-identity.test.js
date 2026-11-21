import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readResource } from '../src/mcp/resources.js';

/**
 * Identity tests for x402://catalog/resource?url= reads (#690).
 *
 * `/discovery/resources?url=` is a filter, not a lookup: it matches prefixes,
 * normalised forms and near misses. readResource used to return
 * `data.resources[0]` whenever the array was non-empty, so a request for one
 * uri could answer with another seller's price and payee. These tests stub
 * fetchDiscovery to hand back exactly the row a loose match would produce and
 * assert the read refuses it instead of relaying it.
 *
 * No network, no Redis: the stub is the whole catalog.
 */

const REQUESTED = 'https://example.com/a/b';

const OTHER_SELLER = {
  url: 'https://example.com/a',
  serviceName: 'Another seller',
  description: 'A neighbouring listing that a prefix match would return',
  type: 'api',
  payTo: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

const NOT_FOUND_MESSAGE = 'No catalog resource matches that url.';

function stubDiscovery(resources) {
  const calls = [];
  const fetchDiscovery = async (path, params) => {
    calls.push([path, params]);
    return { resources };
  };
  return { fetchDiscovery, calls };
}

async function read(url, resources, params = '') {
  const { fetchDiscovery, calls } = stubDiscovery(resources);
  const uri = `x402://catalog/resource?url=${encodeURIComponent(url)}${params}`;
  const result = await readResource(uri, { fetchDiscovery });
  return { body: JSON.parse(result.contents[0].text), calls, uri };
}

describe('x402://catalog/resource?url= returns the resource that was asked for', () => {
  test('an exact match is returned unchanged', async () => {
    const record = {
      url: REQUESTED,
      serviceName: 'The requested seller',
      description: 'exact',
      type: 'api',
      payTo: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };
    const { body, calls } = await read(REQUESTED, [record]);

    assert.deepEqual(body, record);
    assert.equal(calls[0][0], '/discovery/resources');
    assert.equal(calls[0][1].url, REQUESTED);
  });

  test('near match with a different path returns not_found, not another seller record', async () => {
    const { body } = await read(REQUESTED, [OTHER_SELLER]);

    assert.deepEqual(body, { error: 'not_found', message: NOT_FOUND_MESSAGE });
    assert.ok(!JSON.stringify(body).includes(OTHER_SELLER.payTo), 'payee must not leak');
    assert.ok(!JSON.stringify(body).includes(OTHER_SELLER.url), 'url must not leak');
  });

  test('a match carrying an extra query returns not_found', async () => {
    const { body } = await read(REQUESTED, [{ ...OTHER_SELLER, url: `${REQUESTED}?ref=other` }]);

    assert.equal(body.error, 'not_found');
    assert.equal(body.message, NOT_FOUND_MESSAGE);
  });

  test('a trailing-slash difference returns not_found', async () => {
    const url = 'https://example.com/a/';
    const { body } = await read(url, [{ ...OTHER_SELLER, url: 'https://example.com/a' }]);

    assert.equal(body.error, 'not_found');
    assert.equal(body.message, NOT_FOUND_MESSAGE);
  });

  test('an unparseable first url is not_found: no throw, and the value is not echoed', async () => {
    const hostile = 'http://[redacted-seller-value';
    const { body } = await read(REQUESTED, [{ ...OTHER_SELLER, url: hostile }]);

    assert.equal(body.error, 'not_found');
    assert.equal(body.message, NOT_FOUND_MESSAGE);
    assert.ok(!JSON.stringify(body).includes('redacted-seller-value'), 'value must not be echoed');
  });

  test('a missing first url is not_found: no throw, and nothing is echoed', async () => {
    const withoutUrl = {
      serviceName: OTHER_SELLER.serviceName,
      description: OTHER_SELLER.description,
      type: OTHER_SELLER.type,
      payTo: OTHER_SELLER.payTo,
    };
    const { body } = await read(REQUESTED, [withoutUrl]);

    assert.equal(body.error, 'not_found');
    assert.equal(body.message, NOT_FOUND_MESSAGE);
    assert.ok(!JSON.stringify(body).includes('undefined'), 'missing value must not be echoed');
  });

  test('a match with a different toolName is a mismatch', async () => {
    const { body, calls } = await read(
      REQUESTED,
      [{ ...OTHER_SELLER, url: REQUESTED, toolName: 'other-tool' }],
      '&toolName=requested-tool',
    );

    assert.equal(calls[0][1].toolName, 'requested-tool', 'toolName stays in the request');
    assert.equal(body.error, 'not_found');
    assert.equal(body.message, NOT_FOUND_MESSAGE);
  });

  test('an empty result keeps the existing not_found message', async () => {
    const { body } = await read(REQUESTED, []);

    assert.deepEqual(body, { error: 'not_found', message: NOT_FOUND_MESSAGE });
  });
});
