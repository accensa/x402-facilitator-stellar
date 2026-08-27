import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/index.js';
import { McpServer as ServerImplementation } from '../src/mcp/server.js';

test('MCP index exports the server implementation', () => {
  assert.strictEqual(McpServer, ServerImplementation);
});
