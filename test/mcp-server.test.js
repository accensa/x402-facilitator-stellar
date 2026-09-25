import test from 'node:test';
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
