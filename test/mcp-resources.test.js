import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { allResourceUris } from '../src/mcp/resources.js';

/**
 * Protocol tests for the resources capability gate and reads (#515).
 *
 * src/mcp/server.js:84 sets resourcesEnabled only when both `resources` is
 * enabled and fetchDiscovery is a function, :345 advertises the capability
 * only then, and :463 answers withheld methods with -32601. On the advertised
 * side, docs/MCP.md:151 promises unknown/malformed uris are isError results
 * listing knownResources, which src/mcp/resources.js implements via
 * readResource and parseResourceUri with scrub-on-output. None of it was
 * executed in CI, so each tier gets an assertion here with a stub
 * fetchDiscovery -- no network, no Redis.
 */

const ESC = String.fromCharCode(27);

function makeServer(options = {}) {
  const server = new McpServer({ name: 'resources-test', version: '0.0.1', ...options });
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

function stubDiscovery(catalog) {
  const calls = [];
  const fetchDiscovery = async (path, params) => {
    calls.push([path, params]);
    if (path === '/discovery/resources') {
      if (params?.url) {
        return { resources: catalog.resources.filter(r => r.url === params.url) };
      }
      return catalog;
    }
    if (path === '/discovery/search') {
      return { query: params?.query, results: catalog.resources };
    }
    throw new Error(`unexpected discovery path: ${path}`);
  };
  return { fetchDiscovery, calls };
}

const CATALOG = {
  resources: [
    {
      url: 'https://example.com/a',
      serviceName: 'Example A',
      description: 'A test resource',
      type: 'api',
      payTo: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  ],
};

describe('capability gate (src/mcp/server.js:84)', () => {
  test('initialize advertises resources only when enabled and fetchDiscovery is a function', async () => {
    const { fetchDiscovery } = stubDiscovery(CATALOG);

    async function capabilities(options) {
      const { server, sent } = makeServer(options);
      await call(server, 1, 'initialize', { protocolVersion: '2025-06-18' });
      return sent[0].result.capabilities;
    }

    const both = await capabilities({ resources: true, fetchDiscovery });
    assert.ok(both.resources !== undefined, 'both present must advertise');

    const noFn = await capabilities({ resources: true, fetchDiscovery: null });
    assert.ok(noFn.resources === undefined, 'resources without fetchDiscovery withholds');

    const disabled = await capabilities({ resources: false, fetchDiscovery });
    assert.ok(
      disabled.resources === undefined,
      'disabled resources withholds even with a function',
    );

    const neither = await capabilities({ resources: false, fetchDiscovery: null });
    assert.ok(neither.resources === undefined, 'neither present withholds');
  });

  test('withheld capability answers resources/* with -32601, not isError', async () => {
    const { server, sent } = makeServer({ resources: false, fetchDiscovery: async () => ({}) });

    await call(server, 1, 'resources/list');
    assert.equal(sent[0].kind, 'error');
    assert.equal(sent[0].error.code, -32601);
    assert.ok(sent[0].error.data === undefined);

    sent.length = 0;
    await call(server, 2, 'resources/read', { uri: 'x402://catalog/resources' });
    assert.equal(sent[0].kind, 'error', 'withheld read is a protocol error, not isError');
    assert.equal(sent[0].error.code, -32601);
  });
});

describe('resources/list and reads with a stub discovery source', () => {
  test('resources/list enumerates catalog URIs; templates/list advertises parameters', async () => {
    const { fetchDiscovery } = stubDiscovery(CATALOG);
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/list');
    assert.equal(sent[0].kind, 'result');
    const uris = sent[0].result.resources.map(r => r.uri);
    assert.ok(uris.includes('x402://catalog/resources'));

    sent.length = 0;
    await call(server, 2, 'resources/templates/list');
    assert.equal(sent[0].kind, 'result');
    const templates = sent[0].result.resourceTemplates.map(t => t.uriTemplate);
    assert.ok(templates.includes('x402://catalog/search?q={query}'));
    assert.ok(templates.includes('x402://catalog/resource?url={url}'));
    assert.ok(templates.includes('x402://catalog/network/{network}'));
  });

  test('resources/read serves x402://catalog/resources', async () => {
    const { fetchDiscovery } = stubDiscovery(CATALOG);
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'x402://catalog/resources' });
    assert.equal(sent[0].kind, 'result');
    const body = JSON.parse(sent[0].result.contents[0].text);
    assert.deepEqual(body, CATALOG);
  });

  test('resources/read serves x402://catalog/search', async () => {
    const { fetchDiscovery, calls } = stubDiscovery(CATALOG);
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'x402://catalog/search?q=weather' });
    assert.equal(sent[0].kind, 'result');
    assert.equal(calls[0][0], '/discovery/search');
    assert.equal(calls[0][1].query, 'weather');
    const body = JSON.parse(sent[0].result.contents[0].text);
    assert.equal(body.query, 'weather');
  });

  test('resources/read serves x402://catalog/resource?url=', async () => {
    const { fetchDiscovery } = stubDiscovery(CATALOG);
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    const uri = `x402://catalog/resource?url=${encodeURIComponent('https://example.com/a')}`;
    await call(server, 1, 'resources/read', { uri });
    assert.equal(sent[0].kind, 'result');
    const body = JSON.parse(sent[0].result.contents[0].text);
    assert.equal(body.url, 'https://example.com/a');
  });

  test('resources/read serves x402://catalog/network/{network}', async () => {
    const { fetchDiscovery } = stubDiscovery(CATALOG);
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'x402://catalog/network/stellar:testnet' });
    assert.equal(sent[0].kind, 'result');
    const body = JSON.parse(sent[0].result.contents[0].text);
    assert.equal(body.network, 'stellar:testnet');
    assert.equal(body.count, 1);
    assert.equal(body.resources[0].url, 'https://example.com/a');
  });
});

describe('resources/read error tiers (docs/MCP.md:151-152)', () => {
  test('unknown uri returns isError listing knownResources', async () => {
    const { fetchDiscovery } = stubDiscovery(CATALOG);
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'x402://catalog/bogus' });
    assert.equal(sent[0].kind, 'result', 'unknown uri is isError, not -32601');
    const payload = parseIsError(sent[0].result);
    assert.equal(payload.code, 'invalid_input');
    assert.deepEqual([...payload.knownResources].sort(), [...allResourceUris()].sort());
  });

  test('malformed uri returns isError (not -32601)', async () => {
    const { fetchDiscovery } = stubDiscovery(CATALOG);
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'not-a-url' });
    assert.equal(sent[0].kind, 'result', 'malformed uri is isError, not -32601');
    const payload = parseIsError(sent[0].result);
    assert.equal(payload.code, 'invalid_input');
  });

  test('empty match returns not_found message', async () => {
    const { fetchDiscovery } = stubDiscovery({ resources: [] });
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    const uri = `x402://catalog/resource?url=${encodeURIComponent('https://example.com/missing')}`;
    await call(server, 1, 'resources/read', { uri });
    assert.equal(sent[0].kind, 'result');
    const body = JSON.parse(sent[0].result.contents[0].text);
    assert.equal(body.error, 'not_found');
    assert.ok(typeof body.message === 'string');
  });

  test('hostile catalog content comes back scrubbed', async () => {
    const hostile = {
      resources: [
        {
          url: 'https://example.com/evil',
          serviceName: `Bad${String.fromCharCode(0)}Name${ESC}[31m`,
          description: 'evil',
          type: 'api',
          payTo: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      ],
    };
    const { fetchDiscovery } = stubDiscovery(hostile);
    const { server, sent } = makeServer({ resources: true, fetchDiscovery });

    await call(server, 1, 'resources/read', { uri: 'x402://catalog/resources' });
    const text = sent[0].result.contents[0].text;
    assert.ok(!text.includes(String.fromCharCode(0)), 'control chars must be stripped');
    assert.ok(!text.includes('[31m'), 'ANSI bodies must not survive (stringify scrub)');
    const body = JSON.parse(text);
    assert.equal(body.resources[0].serviceName, 'BadName');
  });
});
