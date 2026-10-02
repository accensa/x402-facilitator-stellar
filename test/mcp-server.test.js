import test, { describe } from 'node:test';
import assert from 'node:assert';
import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from '../src/mcp/server.js';

/**
 * Regression test for the MCP protocol-error contract (#196).
 *
 * The bug this guards against: unknown-tool and unknown-method both collapsed
 * to JSON-RPC -32601 ("Method not found"), so a client could not tell "this
 * server has no such tool" from "this server does not speak tools/call". The
 * MCP spec distinguishes the two:
 *
 *   - an unknown TOOL is invalid params -> -32602, message "Unknown tool: <n>"
 *   - an unknown METHOD (protocol level) -> -32601 "Method not found"
 *   - a tool's own execution error -> isError: true tool result, not a protocol
 *     error (unless it is an internal failure, which stays -32603)
 *
 * The three shapes must therefore be distinguishable.
 */
function makeServer() {
  const server = new McpServer({ name: 'test-mcp', version: '0.0.1' });
  server.tool(
    'echo',
    { description: 'echo an argument', properties: { value: { type: 'string' } } },
    async args => args,
  );
  server.tool('boom', { description: 'throws a deliberate tool error' }, async () => {
    const err = new Error('business failure');
    err.isToolError = true;
    err.payload = { code: 'business_failure', message: 'business failure' };
    throw err;
  });
  server.tool('crash', { description: 'throws an internal error' }, async () => {
    throw new Error('internal boom');
  });

  // Redirect the wire-writers so we can assert on the response shape without
  // spawning a subprocess or reading stdout.
  const sent = [];
  server._sendResult = (id, result) => sent.push({ kind: 'result', id, result });
  server._sendError = (id, code, message, data) => {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    sent.push({ kind: 'error', id, error });
  };
  return { server, sent };
}

test('MCP: an unknown tool is invalid params (-32602), names the tool', async () => {
  const { server, sent } = makeServer();
  await server._handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'no_such_tool' },
  });

  assert.equal(sent.length, 1);
  const { kind, id, error } = sent[0];
  assert.equal(kind, 'error');
  assert.equal(id, 1);
  assert.equal(error.code, -32602, 'unknown tool must be -32602 (invalid params), not -32601');
  assert.match(error.message, /Unknown tool: no_such_tool/);
});

test('MCP: unknown tool error.data lists the valid tools for self-correction', async () => {
  const { server, sent } = makeServer();
  await server._handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'no_such_tool' },
  });

  const { error } = sent[0];
  assert.ok(Array.isArray(error.data.validTools));
  assert.deepEqual([...error.data.validTools].sort(), ['boom', 'crash', 'echo']);
});

test('MCP: an unknown method stays -32601 (method not found)', async () => {
  const { server, sent } = makeServer();
  await server._handleRequest({ jsonrpc: '2.0', id: 3, method: 'nonsense/method' });

  assert.equal(sent.length, 1);
  const { kind, id, error } = sent[0];
  assert.equal(kind, 'error');
  assert.equal(id, 3);
  assert.equal(error.code, -32601, 'unknown method must be -32601');
  assert.equal(error.message, 'Method not found');
  assert.ok(error.data === undefined, 'protocol method-not-found should carry no data');
});

test('MCP: a tool error (isToolError) is a result with isError: true, not a protocol error', async () => {
  const { server, sent } = makeServer();
  await server._handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'boom' },
  });

  assert.equal(sent.length, 1);
  const { kind, id, result } = sent[0];
  assert.equal(kind, 'result');
  assert.equal(id, 4);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /business_failure/);
});

test('MCP: a throwing handler with no isToolError is an internal error (-32603)', async () => {
  const { server, sent } = makeServer();
  await server._handleRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'crash' },
  });

  assert.equal(sent.length, 1);
  const { kind, id, error } = sent[0];
  assert.equal(kind, 'error');
  assert.equal(id, 5);
  assert.equal(error.code, -32603, 'unexpected handler throw must be -32603 (internal error)');
  assert.equal(error.message, 'internal boom');
});

test('MCP: missing tool name parameter is invalid params (-32602)', async () => {
  const { server, sent } = makeServer();
  await server._handleRequest({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} });

  assert.equal(sent.length, 1);
  const { kind, error } = sent[0];
  assert.equal(kind, 'error');
  assert.equal(error.code, -32602, 'a missing name parameter is invalid params');
  assert.equal(error.message, 'Unknown tool: (missing name)');
});

/**
 * Protocol version negotiation (#169).
 *
 * The server used to answer every `initialize` with a hardcoded `2024-11-05`,
 * including when the client had asked for something else — so a client could
 * not tell whether the server agreed with it or was ignoring it. Per the spec
 * the server answers with the requested revision when it supports it, and
 * otherwise counter-offers a revision it does support. Each of the three
 * outcomes is pinned here.
 */
function negotiationServer() {
  const warnings = [];
  const server = new McpServer({
    name: 'negotiation-test',
    version: '0.0.1',
    logger: { error: () => {}, warn: message => warnings.push(message) },
  });
  const sent = [];
  server._sendResult = (id, result) => sent.push({ id, result });
  server._sendError = (id, code, message) => sent.push({ id, code, message });
  return { server, sent, warnings };
}

const initialize = (server, protocolVersion) =>
  server._handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion },
  });

test('MCP (#169): a supported protocol version is echoed back, without a warning', async () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const { server, sent, warnings } = negotiationServer();
    await initialize(server, version);

    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].result.protocolVersion,
      version,
      `${version} is supported, so the client's own revision must come back`,
    );
    assert.deepEqual(warnings, [], `no warning for a version we support (${version})`);
  }
});

test('MCP (#169): an unsupported version gets a counter-offer and a warning, not silence', async () => {
  const { server, sent, warnings } = negotiationServer();
  await initialize(server, '1999-01-01');

  assert.equal(sent.length, 1, 'a client that reached the handshake always gets an answer');
  assert.equal(
    sent[0].result.protocolVersion,
    LATEST_PROTOCOL_VERSION,
    'the counter-offer is the newest revision we implement, for the client to accept or refuse',
  );
  assert.equal(warnings.length, 1, 'the mismatch is logged, so negotiation is observable');
  assert.match(warnings[0], /1999-01-01/, 'the warning names the version the client asked for');
  assert.ok(
    SUPPORTED_PROTOCOL_VERSIONS.every(v => warnings[0].includes(v)),
    'the warning lists what the client could have asked for instead',
  );
});

test('MCP (#169): naming no version at all gets the newest supported revision', async () => {
  const { server, sent } = negotiationServer();
  await server._handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  assert.equal(sent[0].result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

test('MCP (#169): a malformed version is treated as unsupported, never echoed', async () => {
  const { server, sent, warnings } = negotiationServer();
  await initialize(server, { protocolVersion: '2025-06-18' });

  assert.equal(sent[0].result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(warnings.length, 1, 'a non-string version is a mismatch worth logging');
});

describe('JSON-RPC 2.0 batch processing (#428)', () => {
  // Real send helpers (makeServer stubs them), so responses flow through the
  // batch sink exactly as they do on the wire.
  function batchServer(options) {
    const server = new McpServer({ name: 'batch-test', version: '0.0.1', ...options });
    server.tool('echo', { description: 'echo' }, async args => args);
    server.tool('slow', { description: 'slow' }, async ({ ms, tag }) => {
      await new Promise(r => setTimeout(r, ms));
      return tag;
    });
    server.tool('crash', { description: 'crash' }, async () => {
      throw new Error('internal boom');
    });
    return server;
  }
  const call = (id, name, args = {}) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  test('returns one response per request, matched by id, with errors isolated', async () => {
    const out = await batchServer()._runBatch([
      call(1, 'echo', { v: 1 }),
      call('two', 'nope'),
      call(3, 'crash'),
      { jsonrpc: '2.0', id: 4, method: 'ping' },
      { jsonrpc: '2.0', id: 5, method: 'bogus' },
    ]);
    assert.deepEqual(
      out.map(r => r.id),
      [1, 'two', 3, 4, 5],
    );
    assert.equal(out[0].result.isError, false);
    assert.equal(out[1].error.code, -32602);
    assert.equal(out[2].error.code, -32603);
    assert.deepEqual(out[3].result, {});
    assert.equal(out[4].error.code, -32601);
  });

  test('members run concurrently, not sequentially', async () => {
    const start = Date.now();
    const out = await batchServer()._runBatch([
      call(1, 'slow', { ms: 150, tag: 'a' }),
      call(2, 'slow', { ms: 150, tag: 'b' }),
      call(3, 'slow', { ms: 150, tag: 'c' }),
    ]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 400, `3 x 150ms calls took ${elapsed}ms; expected concurrent (~150ms)`);
    assert.deepEqual(
      out.map(r => r.result.content[0].text),
      ['a', 'b', 'c'],
    );
  });

  test('invalid members are answered individually; valid ones still run', async () => {
    const out = await batchServer()._runBatch([
      1,
      { jsonrpc: '2.0', id: 'x' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ]);
    assert.deepEqual(
      out.map(r => [r.id, r.error?.code]),
      [
        [null, -32600],
        ['x', -32600],
        [3, undefined],
      ],
    );
  });

  test('notifications get no response, even alongside requests', async () => {
    const out = await batchServer()._runBatch([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'bogus' },
      { jsonrpc: '2.0', id: 7, method: 'ping' },
    ]);
    assert.deepEqual(
      out.map(r => r.id),
      [7],
    );
    assert.deepEqual(await batchServer()._runBatch([{ jsonrpc: '2.0', method: 'ping' }]), []);
  });

  test('an empty batch is refused with a single -32600 error', async () => {
    const out = await batchServer()._runBatch([]);
    assert.equal(Array.isArray(out), false);
    assert.equal(out.error.code, -32600);
    assert.equal(out.id, null);
  });

  test('enforces the maximum batch size (default 25, configurable)', async () => {
    const ping = i => ({ jsonrpc: '2.0', id: i, method: 'ping' });
    const at = await batchServer()._runBatch(Array.from({ length: 25 }, (_, i) => ping(i)));
    assert.equal(at.length, 25, 'exactly the limit is accepted');

    const over = await batchServer()._runBatch(Array.from({ length: 26 }, (_, i) => ping(i)));
    assert.equal(over.error.code, -32600);
    assert.match(over.error.message, /26.*maximum of 25/);

    const small = batchServer({ maxBatchSize: 2 });
    const refused = await small._runBatch([ping(1), ping(2), ping(3)]);
    assert.match(refused.error.message, /maximum of 2/);
  });

  test('concurrent batches do not mix frames', async () => {
    const server = batchServer();
    const [a, b] = await Promise.all([
      server._runBatch([call('a1', 'slow', { ms: 30, tag: 'A' }), call('a2', 'echo')]),
      server._runBatch([call('b1', 'slow', { ms: 10, tag: 'B' }), call('b2', 'echo')]),
    ]);
    assert.deepEqual(
      a.map(r => r.id),
      ['a1', 'a2'],
    );
    assert.deepEqual(
      b.map(r => r.id),
      ['b1', 'b2'],
    );
  });

  test('over HTTP: array in, array out; notifications-only gives 204', async () => {
    const server = batchServer();
    const { port, close } = await server.startSSE();
    try {
      const post = body =>
        fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: JSON.stringify(body) });
      const res = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, call(2, 'echo')]);
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.deepEqual(
        out.map(r => r.id),
        [1, 2],
      );
      const none = await post([{ jsonrpc: '2.0', method: 'ping' }]);
      assert.equal(none.status, 204);
    } finally {
      await close();
    }
  });
});
