/**
 * MCP test helpers for spawning and communicating with the x402-mcp CLI.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/mcp/cli.js');

export function createMcpClient(env = {}) {
  const child = spawn(process.execPath, [CLI_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(d));
  let messageId = 1;
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch {
        console.error('Failed to parse MCP response:', line);
      }
    }
  });
  child.on('exit', code => {
    for (const { reject } of pending.values()) reject(new Error(`Child exited with code ${code}`));
    pending.clear();
  });
  return {
    callTool: (name, args) =>
      new Promise((resolve, reject) => {
        const id = messageId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
          }) + '\n',
        );
      }),
    close: () => child.kill(),
  };
}

export async function createPaymentTestServer({ port = 0, overrides = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url600 = overrides.url600 || '/test-600-stroops';
      const url200 = overrides.url200 || '/test-200-stroops';
      if (req.url === url200) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'payment_required',
            x402Version: 1,
            accepts: [
              {
                scheme: 'exact',
                network: 'stellar:testnet',
                price: { asset: 'native', amount: '200' },
                payTo: 'GBQ...',
              },
            ],
          }),
        );
      } else if (req.url === url600) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'payment_required',
            x402Version: 1,
            accepts: [
              {
                scheme: 'exact',
                network: 'stellar:testnet',
                price: { asset: 'native', amount: '600' },
                payTo: 'GBQ...',
              },
            ],
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(port, () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url600: `http://localhost:${addr.port}/test-600-stroops`,
        url200: `http://localhost:${addr.port}/test-200-stroops`,
      });
    });
    server.on('error', reject);
  });
}

export function assertSpendingRefused(err, pattern) {
  assert.match(err.message, pattern);
}
export function getTestPayerKey() {
  return 'SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW';
}
