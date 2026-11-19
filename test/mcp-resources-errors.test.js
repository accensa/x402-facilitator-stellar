import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { allResourceUris } from '../src/mcp/resources.js';

/**
 * Pins the unknown-resource error contract (#691).
 *
 * docs/MCP.md:151 promises that an unknown or malformed `uri` in
 * `resources/read` is a `result` with `isError: true` whose payload carries
 * `code`, `message`, the offending `uri` and `knownResources` listing the URIs
 * this server does serve. src/mcp/resources.js:238 throws that payload and
 * src/mcp/server.js:504-527 turns the McpInputError into the isError result.
 *
 * The existing test pinned only `code` and a sorted comparison of
 * `knownResources`, so a renamed field, an un-echoed `uri`, or a duplicated
 * entry in `knownResources` would have passed. These assertions compare the
 * whole payload, and require that no discovery request is made: an unknown URI
 * must never reach the facilitator.
 */

/** A fetchDiscovery stub that throws: these cases must never call it. */
function makeNeverCalledDiscovery() {
  const calls = [];
  const fetchDiscovery = async (...args) => {
    calls.push(args);
    throw new Error('fetchDiscovery must not be called for an unknown resource uri');
  };
  return { fetchDiscovery, calls };
}

function makeServer(options = {}) {
  const server = new McpServer({ name: 'resources-errors-test', version: '0.0.1', ...options });
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

/** Unwraps the isError result into the JSON payload a client would parse. */
function readErrorPayload(sent, label) {
  assert.equal(sent.length, 1, `${label}: exactly one response frame`);
  assert.equal(sent[0].kind, 'result', `${label}: isError result, not a JSON-RPC error`);
  assert.equal(sent[0].result.isError, true, `${label}: isError is true`);
  assert.equal(sent[0].result.content[0].type, 'text');
  return JSON.parse(sent[0].result.content[0].text);
}

describe('unknown resource uri payload (#691, docs/MCP.md:151)', () => {
  test('unknown path pins code, message, echoed uri and knownResources as a Set', async () => {
    const { fetchDiscovery, calls } = makeNeverCalledDiscovery();
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'x402://catalog/bogus' });
    const payload = readErrorPayload(sent, 'unknown path');

    assert.deepEqual(Object.keys(payload).sort(), ['code', 'knownResources', 'message', 'uri']);
    assert.equal(payload.code, 'invalid_input');
    assert.equal(payload.message, 'Unknown resource uri: x402://catalog/bogus');
    assert.equal(payload.uri, 'x402://catalog/bogus');

    const uris = allResourceUris();
    const known = new Set(payload.knownResources);
    assert.ok(Array.isArray(payload.knownResources), 'knownResources is a list');
    assert.deepEqual(known, new Set(uris), 'knownResources is exactly allResourceUris()');
    assert.equal(
      payload.knownResources.length,
      uris.length,
      'no duplicates: list length equals allResourceUris().length',
    );
    for (const entry of payload.knownResources) {
      assert.ok(entry.startsWith('x402://'), `${entry} starts with x402://`);
    }
    assert.equal(calls.length, 0, 'discovery was never called');
  });

  test('unknown path keeps the query string in the echoed uri', async () => {
    const { fetchDiscovery, calls } = makeNeverCalledDiscovery();
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'x402://catalog/bogus?x=1' });
    const payload = readErrorPayload(sent, 'unknown path with query');

    assert.deepEqual(Object.keys(payload).sort(), ['code', 'knownResources', 'message', 'uri']);
    assert.equal(payload.code, 'invalid_input');
    assert.equal(payload.message, 'Unknown resource uri: x402://catalog/bogus?x=1');
    assert.equal(payload.uri, 'x402://catalog/bogus?x=1', 'the exact requested uri is echoed');

    const uris = allResourceUris();
    assert.deepEqual(new Set(payload.knownResources), new Set(uris));
    assert.equal(payload.knownResources.length, uris.length);
    for (const entry of payload.knownResources) {
      assert.ok(entry.startsWith('x402://'), `${entry} starts with x402://`);
    }
    assert.equal(calls.length, 0, 'discovery was never called');
  });

  test('wrong scheme pins invalid_input, names x402, and omits knownResources', async () => {
    const { fetchDiscovery, calls } = makeNeverCalledDiscovery();
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'http://catalog/resources' });
    const payload = readErrorPayload(sent, 'wrong scheme');

    assert.equal(payload.code, 'invalid_input');
    assert.match(payload.message, /x402:/, 'the message names the x402 scheme');
    assert.equal(payload.field, 'uri');
    assert.equal(payload.knownResources, undefined);
    assert.ok(
      !Object.keys(payload).includes('knownResources'),
      'knownResources is absent: a wrong-scheme uri is malformed input, not an unknown resource',
    );
    assert.equal(calls.length, 0, 'discovery was never called');
  });
});
