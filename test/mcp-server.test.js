import test from 'node:test';
import assert from 'node:assert';
import { McpServer } from '../src/mcp/server.js';

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
