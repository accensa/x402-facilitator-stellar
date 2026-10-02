/**
 * The two documented CLI entry points (#208).
 *
 * `package.json` `bin` advertises `validate-discovery` (seller-facing) and
 * `x402-mcp` (agent-facing); the README and docs tell people to run exactly
 * those. This test ties the suite to that surface: it resolves the `bin` map
 * from package.json (rather than hardcoding a path, which is what
 * test/sdk-cli.test.js deliberately does for the validator) and drives each
 * binary as a real child process.
 *
 * The MCP half covers what test/mcp.test.js does not: the plain `initialize` /
 * `tools/list` handshake with no payer key configured, and the discovery tools
 * (`search_resources`, `get_resource`) against a stub facilitator. The paid-call
 * spending controls stay in test/mcp.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function binPath(name) {
  const target = PKG.bin?.[name];
  assert.ok(target, `package.json bin is missing "${name}" — it is a documented entry point`);
  return path.resolve(ROOT, target);
}

test('both documented bin targets exist', () => {
  for (const name of ['validate-discovery', 'x402-mcp']) {
    const file = binPath(name);
    assert.ok(fs.existsSync(file), `bin.${name} points at a missing file: ${file}`);
  }
});

test('validate-discovery runs from the declared bin and rejects an invalid declaration', () => {
  const cli = binPath('validate-discovery');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-bin-'));
  try {
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ routeTemplate: '/api/:id', pricing: { amount: '1' } }));
    const out = execFileSync(process.execPath, [cli, good], { encoding: 'utf8' });
    assert.match(out, /Validation passed/);

    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify('not-an-object'));
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [cli, bad], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
      stderr = err.stderr ?? '';
    }
    assert.equal(status, 1, 'an invalid declaration must exit non-zero');
    assert.match(stderr, /invalid_declaration/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Newline-delimited JSON-RPC client over the child's stdio. */
function createMcpClient(env) {
  const child = spawn(process.execPath, [binPath('x402-mcp')], {
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
        // Ignore non-JSON noise.
      }
    }
  });

  child.on('exit', code => {
    for (const { reject } of pending.values()) {
      reject(new Error(`x402-mcp exited with code ${code}`));
    }
    pending.clear();
  });

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = messageId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
    close: () => child.kill(),
  };
}

/** A facilitator stand-in serving the two discovery read routes. */
async function stubFacilitatorServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    seen.push(url.pathname);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/discovery/search') {
      res.end(JSON.stringify({ resources: [{ url: 'https://seller.example/x', price: '1' }] }));
    } else if (url.pathname === '/discovery/resources') {
      res.end(
        JSON.stringify({ resources: [{ url: url.searchParams.get('url'), toolName: null }] }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ invalidReason: 'not_found' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('x402-mcp completes the MCP handshake and lists its tools without a payer key', async () => {
  const client = createMcpClient({ AGENT_PAYER_SECRET_KEY: '' });
  try {
    const init = await client.request('initialize', {});
    assert.equal(init.serverInfo.name, 'x402-facilitator-stellar-mcp');

    const listed = await client.request('tools/list', {});
    const names = listed.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['call_paid_resource', 'get_resource', 'search_resources']);
  } finally {
    client.close();
  }
});

test('x402-mcp discovery tools proxy the facilitator catalog', async () => {
  const stub = await stubFacilitatorServer();
  const client = createMcpClient({
    AGENT_PAYER_SECRET_KEY: '',
    FACILITATOR_URL: stub.base,
  });
  try {
    const search = await client.request('tools/call', {
      name: 'search_resources',
      arguments: { query: 'weather' },
    });
    assert.equal(search.isError, false);
    const searchPayload = JSON.parse(search.content[0].text);
    assert.equal(searchPayload.resources[0].url, 'https://seller.example/x');

    const got = await client.request('tools/call', {
      name: 'get_resource',
      arguments: { url: 'https://seller.example/x' },
    });
    const resource = JSON.parse(got.content[0].text);
    assert.equal(resource.url, 'https://seller.example/x');

    assert.ok(
      stub.seen.includes('/discovery/search'),
      'search_resources must hit the search route',
    );
    assert.ok(
      stub.seen.includes('/discovery/resources'),
      'get_resource must hit the resources route',
    );
  } finally {
    client.close();
    await stub.close();
  }
});
