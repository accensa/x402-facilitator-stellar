import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_RESOURCES_ALLOWLIST,
  GET_RESOURCE_ALLOWLIST,
  validateToolArgs,
  server,
} from '../src/mcp/cli.js';
import { McpInputError } from '../src/mcp/sanitize.js';

test('SEARCH_RESOURCES_ALLOWLIST contains exactly the declared schema properties', () => {
  const expected = new Set(['query', 'limit', 'type', 'extensions', 'payTo', 'scheme', 'network']);
  assert.deepEqual(SEARCH_RESOURCES_ALLOWLIST, expected);
});

test('GET_RESOURCE_ALLOWLIST contains exactly the declared schema properties', () => {
  const expected = new Set(['url', 'toolName']);
  assert.deepEqual(GET_RESOURCE_ALLOWLIST, expected);
});

test('validateToolArgs allows declared properties for search_resources and get_resource', () => {
  const validSearch = {
    query: 'stellar',
    limit: 10,
    type: 'http',
    extensions: ['bazaar'],
    payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    scheme: 'exact',
    network: 'stellar:testnet',
  };
  assert.doesNotThrow(() =>
    validateToolArgs('search_resources', validSearch, SEARCH_RESOURCES_ALLOWLIST, {
      arrayAllowedKeys: new Set(['extensions']),
    }),
  );

  const validGet = {
    url: 'https://api.example.com/data',
    toolName: 'my_tool',
  };
  assert.doesNotThrow(() => validateToolArgs('get_resource', validGet, GET_RESOURCE_ALLOWLIST));
});

test('validateToolArgs rejects unexpected arguments not defined in the tool schema', () => {
  assert.throws(
    () =>
      validateToolArgs(
        'search_resources',
        { query: 'stellar', unexpectedKey: 'malicious' },
        SEARCH_RESOURCES_ALLOWLIST,
        { arrayAllowedKeys: new Set(['extensions']) },
      ),
    err => err instanceof McpInputError && err.isToolError && /unexpected/i.test(err.message),
  );

  assert.throws(
    () =>
      validateToolArgs(
        'get_resource',
        { url: 'https://example.com', injectParam: 'true' },
        GET_RESOURCE_ALLOWLIST,
      ),
    err => err instanceof McpInputError && err.isToolError && /unexpected/i.test(err.message),
  );
});

test('validateToolArgs rejects disallowed array values that violate schema constraints', () => {
  // query is declared as string, passing an array must be rejected
  assert.throws(
    () =>
      validateToolArgs(
        'search_resources',
        { query: ['stellar', 'payments'] },
        SEARCH_RESOURCES_ALLOWLIST,
        { arrayAllowedKeys: new Set(['extensions']) },
      ),
    err => err instanceof McpInputError && err.isToolError && /array/i.test(err.message),
  );

  // limit is declared as number, passing an array must be rejected
  assert.throws(
    () =>
      validateToolArgs('search_resources', { limit: [10, 20] }, SEARCH_RESOURCES_ALLOWLIST, {
        arrayAllowedKeys: new Set(['extensions']),
      }),
    err => err instanceof McpInputError && err.isToolError && /array/i.test(err.message),
  );

  // get_resource does not allow array values for url or toolName
  assert.throws(
    () =>
      validateToolArgs(
        'get_resource',
        { url: ['https://example.com/1', 'https://example.com/2'] },
        GET_RESOURCE_ALLOWLIST,
      ),
    err => err instanceof McpInputError && err.isToolError && /array/i.test(err.message),
  );
});

test('MCP tool handlers enforce allowlist and return tool errors (isError: true)', async () => {
  const searchTool = server.tools.get('search_resources');
  assert.ok(searchTool, 'search_resources tool must be registered');

  await assert.rejects(
    async () => searchTool.handler({ query: 'test', extraKey: 'fail' }),
    err => err.isToolError === true && /unexpected/i.test(err.message),
  );

  await assert.rejects(
    async () => searchTool.handler({ query: ['not', 'a', 'string'] }),
    err => err.isToolError === true && /array/i.test(err.message),
  );

  const getTool = server.tools.get('get_resource');
  assert.ok(getTool, 'get_resource tool must be registered');

  await assert.rejects(
    async () => getTool.handler({ url: 'https://example.com', unapproved: 1 }),
    err => err.isToolError === true && /unexpected/i.test(err.message),
  );

  await assert.rejects(
    async () => getTool.handler({ url: ['https://example.com'] }),
    err => err.isToolError === true && /array/i.test(err.message),
  );
});
