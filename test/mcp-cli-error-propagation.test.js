/**
 * How the MCP CLI reports a failed facilitator read (#694).
 *
 * `fetchDiscovery` in `src/mcp/cli.js` prefers a JSON `invalidReason`, falls
 * back to `HTTP <status>` when the body is JSON without one, and swallows a
 * parse error when the body is not JSON at all (a proxy 502 with an HTML
 * maintenance page). A later change that let the `res.json()` parse error
 * escape would replace the diagnostic with a JSON parse message and make an
 * upstream failure look like a bug inside the agent.
 *
 * These tests spawn the real CLI against a loopback stub and drive
 * `search_resources` over newline-delimited JSON-RPC on stdio. They record the
 * envelope the CLI produces today: a tool handler that throws a plain `Error`
 * is reported by `McpServer` as a `-32603` JSON-RPC error whose message is the
 * diagnostic, not as an `isError` tool result (only `isToolError` throws take
 * that path). Changing that classification requires a change in
 * `src/mcp/cli.js` or `src/mcp/server.js`, so it is pinned here rather than
 * assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../src/mcp/cli.js', import.meta.url));

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
const SEARCH = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'search_resources', arguments: { query: 'weather forecast' } },
};

/** A copy of the current environment with `overrides` applied (undefined unsets). */
function envWith(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/** Starts a facilitator stub on 127.0.0.1:0 and returns its origin and closer. */
async function startStub(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise(resolve => {
        // A never-answering stub still holds the request socket.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Spawns the CLI with an explicit environment and a line-oriented stdout
 * reader. No payer secret is configured: search_resources never spends.
 */
function spawnCli(facilitatorUrl, { fetchTimeoutMs = 100 } = {}) {
  const child = spawn(process.execPath, [CLI], {
    cwd: ROOT,
    env: envWith({
      FACILITATOR_URL: facilitatorUrl,
      MCP_FETCH_TIMEOUT_MS: fetchTimeoutMs,
      MAX_FEE_PER_CALL_STROOPS: '1000',
      MAX_SESSION_SPEND_STROOPS: '10000',
      AGENT_PAYER_SECRET_KEY: undefined,
      NETWORK: undefined,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const frames = [];
  const listeners = new Set();
  let stdoutBuffer = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      frames.push(frame);
      for (const listener of [...listeners]) listener(frame);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  return {
    child,
    frames,
    stderr: () => stderr,
    send: message => child.stdin.write(`${JSON.stringify(message)}\n`),
    waitForId(id, timeoutMs = 5000) {
      const existing = frames.find(frame => frame.id === id);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(
            new Error(
              `timed out waiting for frame id ${id}; got ${JSON.stringify(frames)}; stderr: ${stderr}`,
            ),
          );
        }, timeoutMs);
        const listener = frame => {
          if (frame.id !== id) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(frame);
        };
        listeners.add(listener);
      });
    },
    async dispose() {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    },
  };
}

/**
 * Awaits the tools/call answer, asserts today's `-32603` envelope (not a silent
 * success and not an `isError` result), and returns the diagnostic message.
 */
async function searchAndAssertDiagnostic(t, stub, client) {
  t.after(async () => {
    await client.dispose();
    await stub.close();
  });

  client.send(INITIALIZE);
  client.send(SEARCH);

  const frame = await client.waitForId(2);
  assert.equal(
    frame.result,
    undefined,
    `today a facilitator failure is a JSON-RPC error, not an isError result: ${JSON.stringify(frame.result)}`,
  );
  assert.equal(
    frame.error?.code,
    -32603,
    `expected the current -32603 envelope, got ${JSON.stringify(frame.error)}`,
  );
  assert.equal(typeof frame.error.message, 'string');
  return frame.error.message;
}

test('JSON error body with invalidReason: -32603 carrying the reason, not the status', async t => {
  const stub = await startStub((_req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ invalidReason: 'facilitator_catalog_unavailable' }));
  });
  const client = spawnCli(stub.url);

  const text = await searchAndAssertDiagnostic(t, stub, client);
  assert.match(text, /facilitator_catalog_unavailable/, 'the reason must reach the agent');
  assert.doesNotMatch(text, /HTTP 502/, 'invalidReason wins over the bare status');
});

test('JSON error body without invalidReason: -32603 reporting HTTP 502', async t => {
  const stub = await startStub((_req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'no reason field here' }));
  });
  const client = spawnCli(stub.url);

  const text = await searchAndAssertDiagnostic(t, stub, client);
  assert.match(text, /HTTP 502/, 'the status must be the fallback diagnostic');
});

test('non-JSON HTTP 502: -32603 reporting HTTP 502 with no parse message', async t => {
  const stub = await startStub((_req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>');
  });
  const client = spawnCli(stub.url);

  const text = await searchAndAssertDiagnostic(t, stub, client);
  assert.match(text, /HTTP 502/, 'the HTML body must not hide the status');
  assert.doesNotMatch(
    text,
    /Unexpected token|JSON|parse/i,
    'a swallowed parse error must not surface as the diagnostic',
  );
});

test('request timeout with MCP_FETCH_TIMEOUT_MS=100: -32603 with the deadline message', async t => {
  const stub = await startStub(() => {
    // Never respond: the CLI's AbortSignal.timeout must end the wait.
  });
  const client = spawnCli(stub.url, { fetchTimeoutMs: 100 });

  const started = Date.now();
  const text = await searchAndAssertDiagnostic(t, stub, client);
  const elapsed = Date.now() - started;

  assert.match(text, /timed out after 100ms/, 'the deadline must name the budget');
  assert.ok(elapsed < 2000, `the timeout must surface promptly (took ${elapsed}ms)`);
});
