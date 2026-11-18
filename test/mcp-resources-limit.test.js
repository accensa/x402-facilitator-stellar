import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';

/**
 * Range tests for the `limit` parameter of `x402://catalog/search` (#689).
 *
 * The resource validated `limit` with /^\d{1,3}$/ while its own hint promised
 * "a number between 1 and 100" and the `search_resources` tool advertised
 * "max 100", so `0` and `999` were accepted, converted with Number() and
 * forwarded to /discovery/search. These tests pin both boundaries through the
 * same harness as test/mcp-resources.test.js: a stub fetchDiscovery, no
 * network, no Redis.
 */

function makeServer(options = {}) {
  const server = new McpServer({ name: 'resources-limit-test', version: '0.0.1', ...options });
  const sent = [];
  server._sendResult = (id, result) => sent.push({ kind: 'result', id, result });
  server._sendError = (id, code, message, data) => {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    sent.push({ kind: 'error', id, error });
  };
  return { server, sent };
}

const call = (server, id, method, params = {}) =>
  server._handleRequest({ jsonrpc: '2.0', id, method, params });

function parseIsError(result) {
  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content));
  return JSON.parse(result.content[0].text);
}

/** Reads `uri` through a server whose discovery calls are recorded. */
async function read(uri) {
  const calls = [];
  const fetchDiscovery = async (path, params) => {
    calls.push([path, params]);
    if (path === '/discovery/search') return { query: params?.query, results: [] };
    throw new Error(`unexpected discovery path: ${path}`);
  };
  const { server, sent } = makeServer({ resources: true, fetchDiscovery });
  await call(server, 1, 'resources/read', { uri });
  assert.equal(sent.length, 1, 'exactly one response per read');
  return { sent, calls };
}

const searchUri = limit => `x402://catalog/search?q=weather&limit=${encodeURIComponent(limit)}`;

const RANGE_MESSAGE = "'limit' must be between 1 and 100";

const searchCalls = calls => calls.filter(([path]) => path === '/discovery/search');

describe('x402://catalog/search limit range (#689)', () => {
  test('limit 0 and 999 are rejected as invalid_input; 1 and 100 are forwarded as numbers', async () => {
    for (const bad of ['0', '999']) {
      const { sent, calls } = await read(searchUri(bad));
      assert.equal(sent[0].kind, 'result', 'a bad limit is a tool error, not -32601');
      const payload = parseIsError(sent[0].result);
      assert.equal(payload.code, 'invalid_input');
      assert.equal(payload.field, 'limit');
      // Exact wording, which also proves the raw value is never echoed: a
      // message containing it would not equal this string.
      assert.equal(payload.message, RANGE_MESSAGE);
      assert.match(payload.message, /1/);
      assert.match(payload.message, /100/);
      assert.deepEqual(searchCalls(calls), [], 'nothing reaches /discovery/search');
    }

    for (const good of ['1', '100']) {
      const { sent, calls } = await read(searchUri(good));
      assert.equal(sent[0].kind, 'result');
      assert.equal(sent[0].result.isError, undefined, `limit=${good} must not be an error`);
      const forwarded = searchCalls(calls);
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0][1].limit, Number(good));
      assert.equal(typeof forwarded[0][1].limit, 'number', 'limit is forwarded as a number');
    }
  });

  test('limit 101 is rejected as invalid_input and never forwarded', async () => {
    const { sent, calls } = await read(searchUri('101'));
    const payload = parseIsError(sent[0].result);
    assert.equal(payload.code, 'invalid_input');
    assert.equal(payload.field, 'limit');
    assert.equal(payload.message, RANGE_MESSAGE);
    assert.ok(!payload.message.includes('101'), 'the raw value is not echoed');
    assert.deepEqual(searchCalls(calls), []);
  });

  test('an omitted limit sends no limit key at all', async () => {
    const { sent, calls } = await read('x402://catalog/search?q=weather');
    assert.equal(sent[0].kind, 'result');
    assert.equal(sent[0].result.isError, undefined);
    const forwarded = searchCalls(calls);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0][1].query, 'weather');
    assert.ok(!('limit' in forwarded[0][1]), 'the key must be absent, not undefined or null');
  });

  test('non-numeric and over-long limits still fail before the range check, without echoing the value', async () => {
    for (const bad of ['abc', '1e2']) {
      const { sent, calls } = await read(searchUri(bad));
      const payload = parseIsError(sent[0].result);
      assert.equal(payload.code, 'invalid_input');
      assert.equal(payload.field, 'limit');
      assert.match(payload.message, /malformed/, 'non-numeric input is still malformed');
      assert.ok(!payload.message.includes(bad), `the raw value (${bad}) must not be echoed`);
      assert.deepEqual(searchCalls(calls), []);
    }

    // Longer than the existing maxLength, so it fails as oversized rather than
    // reaching Number(); the regex and maxLength are deliberately unchanged.
    const { sent, calls } = await read(searchUri('12345'));
    const payload = parseIsError(sent[0].result);
    assert.equal(payload.code, 'invalid_input');
    assert.equal(payload.field, 'limit');
    assert.ok(!payload.message.includes('12345'), 'the raw value must not be echoed');
    assert.deepEqual(searchCalls(calls), []);
  });
});
