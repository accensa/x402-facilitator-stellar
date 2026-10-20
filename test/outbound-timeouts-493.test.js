import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Keypair } from '@stellar/stellar-sdk';
import { loadRemoteKeys } from '../src/facilitator.js';
import { defaultRpcCall } from '../src/store/reconciliation.js';
import { fetchWithTimeout, parseStroopsLimit } from '../src/mcp/cli.js';

/** A stub server that accepts connections but never responds. */
async function hangingServer() {
  const server = http.createServer(() => {
    // Intentionally never respond.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('loadRemoteKeys times out instead of stalling signer rotation (#493, src/facilitator.js:14)', async () => {
  const stub = await hangingServer();
  try {
    await assert.rejects(() => loadRemoteKeys(stub.url, 100), /timed out after 100ms/);
  } finally {
    await stub.close();
  }
});

test('loadRemoteKeys names the field that failed (#493)', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ wrong: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(() => loadRemoteKeys(url, 2000), /"keys"/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('loadRemoteKeys accepts a valid keys payload (#493)', async () => {
  const secret = Keypair.random().secret();
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [secret] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await loadRemoteKeys(url, 2000), [secret]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('reconciliation RPC cannot stall the sweep (#493)', async () => {
  const stub = await hangingServer();
  try {
    await assert.rejects(
      () => defaultRpcCall(stub.url, { jsonrpc: '2.0', id: 1, method: 'getTransaction' }, 100),
      /timed out after 100ms/,
    );
  } finally {
    await stub.close();
  }
});

test('MCP fetches fail with a clear deadline message (#493)', async () => {
  const stub = await hangingServer();
  try {
    await assert.rejects(() => fetchWithTimeout(stub.url, {}, 100), /timed out after 100ms/);
  } finally {
    await stub.close();
  }
});

test('spend-cap parse names the field that failed (#493)', () => {
  assert.equal(parseStroopsLimit('1000', 'MAX_FEE_PER_CALL_STROOPS', '1000'), 1000n);
  assert.throws(
    () => parseStroopsLimit('abc', 'MAX_FEE_PER_CALL_STROOPS', '1000'),
    /MAX_FEE_PER_CALL_STROOPS/,
  );
  assert.throws(
    () => parseStroopsLimit('', 'MAX_SESSION_SPEND_STROOPS', '10000'),
    /MAX_SESSION_SPEND_STROOPS/,
  );
});
