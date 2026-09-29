/**
 * MCP client and MCP CLI: unit tests, explicit error states, and the spending
 * controls end to end.
 *
 * TESTING STRATEGY (#386, #388)
 *
 * The subject of this file is the test-only MCP client in
 * ./helpers/mcp-client.js and, through it, the MCP CLI in src/mcp/cli.js. It is
 * organised so every layer can fail for its own reason:
 *
 * 1. Primitives (LineFramer, BoundedCapture) are tested in isolation against a
 *    naive implementation, so "same behaviour, less work" is a comparison
 *    rather than a claim. The naive reader below is the exact loop the framer
 *    replaced.
 * 2. The client's request/response, timeout, framing and teardown paths are
 *    driven over a real stdio pipe against test/fixtures/mcp/scripted-cli.js,
 *    which can be told to answer with an error, print non-JSON noise, reply one
 *    byte at a time, stay silent, or die mid-request.
 * 3. The paths a real child cannot be made to produce on demand (spawn
 *    failure, a stdin write that fails or throws, a kill that throws) are
 *    driven through an injected `spawn`, so they are synchronous and
 *    deterministic instead of timing-dependent.
 * 4. The CLI's spending controls are exercised end to end against a mock 402
 *    server. Every case asserts a refusal that happens *before* signing, which
 *    keeps the suite offline: no funded account, no testnet, no facilitator.
 *    The settled-payment path needs real testnet settlement and is covered by
 *    the conformance workflow (npm run e2e), not here.
 * 5. Coverage is enforced structurally: every code in
 *    MCP_CLIENT_ERROR_CODES must be produced by a test in this file, checked by
 *    the final test. Node's test runner excludes test/ from its coverage
 *    report, so an exhaustion guard is what keeps "the client's error handling
 *    is covered" from rotting as codes are added.
 */
import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BoundedCapture,
  LineFramer,
  MCP_CLIENT_ERROR_CODES,
  McpClientError,
  createMcpClient,
} from './helpers/mcp-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTED_CLI = path.join(HERE, 'fixtures/mcp/scripted-cli.js');

/** A structurally valid Stellar testnet secret key; never funded, never used to pay. */
const TEST_PAYER_KEY = 'SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW';

/* -------------------------------------------------------------------------- *
 * Error-code coverage harness (#386)
 *
 * Every failure assertion goes through expectFailure(), which records the code
 * it observed. The last test compares the recorded set with the declared list,
 * so a code with no test — or a test that stopped exercising its code — fails.
 * -------------------------------------------------------------------------- */

const observedCodes = new Set();

async function expectFailure(promise, code, what) {
  let outcome;
  try {
    outcome = { resolved: true, value: await promise };
  } catch (error) {
    outcome = { resolved: false, error };
  }

  assert.strictEqual(
    outcome.resolved,
    false,
    `${what}: expected a ${code} rejection, resolved with ${JSON.stringify(outcome.value)}`,
  );

  const error = outcome.error;
  observedCodes.add(error?.code);
  assert.ok(
    error instanceof McpClientError,
    `${what}: expected an McpClientError, got ${error?.name}: ${error?.message}`,
  );
  assert.strictEqual(error.code, code, `${what}: unexpected error code (${error.message})`);
  return error;
}

/**
 * Records every code an `onError` observer sees, so the coverage guard counts
 * errors reported asynchronously as well as ones that surface as rejections.
 */
function recordingOnError(sink = []) {
  const observer = error => {
    observedCodes.add(error?.code);
    sink.push(error);
  };
  observer.errors = sink;
  return observer;
}

/**
 * A ChildProcess stand-in good enough for createMcpClient: two readable
 * streams, a writable stdin, and kill(). Lets the client's plumbing failures be
 * triggered on demand instead of hoped for.
 */
class FakeChild extends EventEmitter {
  constructor({ writeError = null, writeThrows = null, killError = null, autoExit = false } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.killError = killError;
    this.autoExit = autoExit;
    this.written = [];
    this.stdin = {
      write: (chunk, callback) => {
        this.written.push(chunk);
        if (writeThrows) throw writeThrows;
        if (writeError) {
          callback?.(writeError);
          return false;
        }
        callback?.(null);
        return true;
      },
    };
  }

  kill(signal) {
    if (this.killError) throw this.killError;
    this.killed = true;
    if (this.autoExit) this.emit('exit', 0, signal);
    return true;
  }
}

/** Spawn stub: hands the test its FakeChild back, optionally after throwing. */
function fakeSpawn(child, { throws = null } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (throws) throw throws;
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** The naive reader the framer replaced; the benchmark's baseline. */
function naiveLineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        onLine(line);
      }
    },
  };
}

/**
 * The same loop with a counter for the characters it hands to `split()`. The
 * counter is the only difference, so the number it reports is the work the
 * reader above really does — one re-scan of the undelivered tail per read.
 */
function measuringNaiveReader(onLine) {
  let buffer = '';
  let scannedCharacters = 0;
  return {
    push(chunk) {
      buffer += chunk.toString();
      scannedCharacters += buffer.length;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        onLine(line);
      }
    },
    get scannedCharacters() {
      return scannedCharacters;
    },
  };
}

function ndjson(count, payloadChars) {
  return (
    Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: i,
        result: { content: [{ type: 'text', text: 'x'.repeat(payloadChars) }] },
      }),
    ).join('\n') + '\n'
  );
}

function chunkInto(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(Buffer.from(text.slice(i, i + size)));
  return chunks;
}

/** Fastest of `runs` timings — the least noisy summary under a loaded machine. */
function fastestOf(runs, work) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    work();
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/* -------------------------------------------------------------------------- *
 * LineFramer (#388)
 * -------------------------------------------------------------------------- */

test('LineFramer: same line contract as the naive split loop', () => {
  const fixtures = {
    'one message per chunk': ['{"a":1}\n', '{"b":2}\n'],
    'a message split across many chunks': ['{"a"', ':1}\n{"b"', ':2}\n'],
    'several messages in one chunk': ['{"a":1}\n{"b":2}\n{"c":3}\n'],
    'blank and whitespace-only lines are skipped': ['\n{"a":1}\n   \n{"b":2}\n'],
    'a trailing partial line stays pending': ['{"a":1}\n{"b"'],
    'CRLF line endings': ['{"a":1}\r\n{"b":2}\r\n'],
    'a message 1 KiB long delivered 64 bytes at a time': chunkInto(
      `${JSON.stringify({ a: 'y'.repeat(1000) })}\n`,
      64,
    ),
  };

  for (const [label, chunks] of Object.entries(fixtures)) {
    const expected = [];
    const actual = [];
    const naive = naiveLineReader(line => expected.push(line));
    const framer = new LineFramer(line => actual.push(line));

    for (const chunk of chunks) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      naive.push(piece);
      framer.push(piece);
    }

    assert.deepStrictEqual(
      actual,
      expected,
      `${label}: the framer must emit exactly the same lines`,
    );
  }
});

test('LineFramer: pending bytes are reported, and never leak into the next message', () => {
  const lines = [];
  const framer = new LineFramer(line => lines.push(line));

  framer.push('{"a":1}\n{"partial"');
  assert.strictEqual(framer.pending, '{"partial"', 'the unterminated tail is still buffered');
  assert.deepStrictEqual(lines, ['{"a":1}']);

  framer.push(':done}\n');
  assert.strictEqual(framer.pending, '');
  assert.deepStrictEqual(
    lines,
    ['{"a":1}', '{"partial":done}'],
    'the tail is completed, not dropped',
  );

  framer.push('only a tail');
  assert.strictEqual(framer.pending, 'only a tail', 'a chunk with no newline is all tail');
});

/* -------------------------------------------------------------------------- *
 * BoundedCapture (#388)
 * -------------------------------------------------------------------------- */

test('BoundedCapture: retention is bounded by the cap, not by the child', () => {
  const cap = 1024;
  const chunkSize = 4096;
  const chunks = 2048; // 8 MiB of child output

  const bounded = new BoundedCapture(cap);
  const unbounded = [];
  for (let i = 0; i < chunks; i++) {
    const chunk = Buffer.alloc(chunkSize, 0x61);
    unbounded.push(chunk);
    bounded.push(chunk);
  }

  const unboundedBytes = unbounded.reduce((total, chunk) => total + chunk.length, 0);
  assert.strictEqual(unboundedBytes, chunks * chunkSize, 'the baseline really did receive 8 MiB');
  assert.strictEqual(bounded.retainedBytes, cap, 'only the cap is retained');
  assert.strictEqual(bounded.text().length, cap, 'only the cap is rendered');
  assert.strictEqual(bounded.truncated, true, 'the caller can tell output was dropped');
  assert.strictEqual(
    bounded.text(),
    'a'.repeat(cap),
    'the retained bytes are the head of the stream, where a crash explains itself',
  );

  // Metric: memory a chatty peer can cost, cap vs. naive retention.
  console.log(
    `    stderr retention: ${bounded.retainedBytes} B capped vs ${unboundedBytes} B unbounded ` +
      `(${(unboundedBytes / bounded.retainedBytes).toFixed(0)}x)`,
  );
});

test('BoundedCapture: a stream under the cap is retained whole, and text() is stable', () => {
  const capture = new BoundedCapture(64);
  capture.push('crash: ');
  capture.push('boom\n');

  assert.strictEqual(capture.truncated, false);
  assert.strictEqual(capture.retainedBytes, 12);
  assert.strictEqual(capture.text(), 'crash: boom\n');
  assert.strictEqual(capture.text(), capture.text(), 'rendering is memoised, not recomputed');

  capture.push('more');
  assert.strictEqual(
    capture.text(),
    'crash: boom\nmore',
    'appending invalidates the memoised text',
  );
});

/* -------------------------------------------------------------------------- *
 * The client, over a real pipe
 * -------------------------------------------------------------------------- */

/** Spawns the scripted peer and returns a client plus its async errors. */
function clientFor(mode, options = {}) {
  const errors = recordingOnError();
  const client = createMcpClient(
    { FAKE_MCP_MODE: mode, AGENT_PAYER_SECRET_KEY: TEST_PAYER_KEY },
    {
      cliPath: SCRIPTED_CLI,
      timeout: 2000,
      echoStderr: false,
      onError: errors,
      ...options,
    },
  );
  return { client, errors };
}

test('MCP client: a request round-trips over stdio', async t => {
  const { client, errors } = clientFor('echo');
  t.after(() => !client.isClosed() && client.close());

  const result = await client.callTool('search_resources', { query: 'weather' });
  assert.strictEqual(result.content[0].text, 'echo:search_resources');
  assert.deepStrictEqual(errors.errors, [], 'a clean call reports nothing asynchronously');
});

test('MCP client: a response delivered one byte at a time is reassembled', async t => {
  // The peer writes a byte per event-loop turn, so every read boundary lands
  // inside the JSON. A framer that dropped the tail would fail here, and only
  // here.
  const { client } = clientFor('split');
  t.after(() => !client.isClosed() && client.close());

  const result = await client.callTool('call_paid_resource', { url: 'http://example.com' });
  assert.strictEqual(result.content[0].text, 'echo:call_paid_resource');
});

test('MCP client: non-JSON noise is reported as PARSE_ERROR without losing the real response', async t => {
  const { client, errors } = clientFor('garbage');
  t.after(() => !client.isClosed() && client.close());

  const result = await client.callTool('search_resources', {});
  assert.strictEqual(result.content[0].text, 'echo:search_resources');

  const parseErrors = errors.errors.filter(error => error.code === 'PARSE_ERROR');
  assert.strictEqual(parseErrors.length, 1, 'the unparseable line is reported once');
  assert.strictEqual(parseErrors[0].context.line, 'this line is not json');
  assert.ok(parseErrors[0].context.parseError, 'the parse failure carries its cause');
});

test('MCP client: a JSON-RPC error becomes TOOL_CALL_FAILED with its code and data', async t => {
  const { client } = clientFor('tool-error');
  t.after(() => !client.isClosed() && client.close());

  const error = await expectFailure(
    client.callTool('call_paid_resource', { url: 'http://example.com' }),
    'TOOL_CALL_FAILED',
    'scripted tool error',
  );
  assert.strictEqual(error.message, 'scripted tool failure', 'the tool message is propagated');
  assert.strictEqual(error.context.errorCode, -32000);
  assert.deepStrictEqual(error.context.errorData, { hint: 'retry later' });
});

test('MCP client: a silent peer is a TIMEOUT naming the tool and the budget', async t => {
  const { client } = clientFor('silent', { timeout: 150 });
  t.after(() => !client.isClosed() && client.close());

  const error = await expectFailure(
    client.callTool('call_paid_resource', { url: 'http://example.com' }),
    'TIMEOUT',
    'silent peer',
  );
  assert.strictEqual(error.context.toolName, 'call_paid_resource');
  assert.strictEqual(error.context.timeoutMs, 150);
});

test('MCP client: a peer that dies with a request in flight is PROCESS_EXIT', async t => {
  const { client } = clientFor('exit', { timeout: 5000 });
  t.after(() => !client.isClosed() && client.close());

  const error = await expectFailure(
    client.callTool('call_paid_resource', { url: 'http://example.com' }),
    'PROCESS_EXIT',
    'peer dying mid-request',
  );
  assert.strictEqual(error.context.exitCode, 3, 'the exit status is reported, not guessed');
  assert.strictEqual(typeof error.context.stderr, 'string', 'stderr is attached for diagnosis');
});

test('MCP client: close() rejects in-flight calls and refuses new ones', async t => {
  const { client } = clientFor('silent', { timeout: 5000 });
  t.after(() => !client.isClosed() && client.close());

  const inFlight = client.callTool('call_paid_resource', { url: 'http://example.com' });
  client.close();

  const inFlightError = await expectFailure(inFlight, 'CLIENT_CLOSED', 'a call in flight at close');
  assert.match(inFlightError.message, /client was closed/);
  assert.strictEqual(client.isClosed(), true);

  const afterClose = await expectFailure(
    client.callTool('call_paid_resource', { url: 'http://example.com' }),
    'CLIENT_CLOSED',
    'a call after close',
  );
  assert.match(afterClose.message, /closed MCP client/);

  client.close(); // idempotent: a second close must not throw or double-kill
  assert.strictEqual(client.isClosed(), true);
});

/* -------------------------------------------------------------------------- *
 * The client's plumbing, via an injected spawn
 * -------------------------------------------------------------------------- */

test('MCP client: a spawn that throws is SPAWN_FAILED, synchronously', () => {
  const spawn = fakeSpawn(null, { throws: new Error('spawn EACCES') });
  assert.throws(
    () => createMcpClient({}, { spawn, cliPath: '/nope' }),
    error => {
      observedCodes.add(error.code);
      assert.strictEqual(error.code, 'SPAWN_FAILED');
      assert.strictEqual(error.context.cliPath, '/nope');
      assert.strictEqual(error.context.originalError, 'spawn EACCES');
      return true;
    },
  );
});

test('MCP client: a child process error rejects every in-flight call', async () => {
  const child = new FakeChild();
  const errors = recordingOnError();
  const client = createMcpClient(
    {},
    { spawn: fakeSpawn(child), onError: errors, echoStderr: false },
  );
  assert.strictEqual(
    fakeSpawn(child).calls.length,
    0,
    'the stub is not called until the client spawns',
  );

  const first = client.callTool('one', {});
  const second = client.callTool('two', {});
  child.emit('error', new Error('EACCES'));

  for (const [call, name] of [
    [first, 'one'],
    [second, 'two'],
  ]) {
    const error = await expectFailure(call, 'PROCESS_ERROR', `${name} after a child error`);
    assert.strictEqual(error.context.originalError, 'EACCES');
    assert.strictEqual(typeof error.context.stderr, 'string');
  }
  assert.strictEqual(errors.errors.length, 1, 'the process error is reported once, not per call');
});

test('MCP client: stdin failures surface as STDIN_WRITE_ERROR and STDIN_WRITE_EXCEPTION', async () => {
  const failing = new FakeChild({ writeError: new Error('write EPIPE') });
  const clientA = createMcpClient({}, { spawn: fakeSpawn(failing), echoStderr: false });
  const errorA = await expectFailure(
    clientA.callTool('one', {}),
    'STDIN_WRITE_ERROR',
    'stdin write',
  );
  assert.strictEqual(errorA.context.originalError, 'write EPIPE');

  const throwing = new FakeChild({ writeThrows: new Error('stdin is destroyed') });
  const clientB = createMcpClient({}, { spawn: fakeSpawn(throwing), echoStderr: false });
  const errorB = await expectFailure(
    clientB.callTool('one', {}),
    'STDIN_WRITE_EXCEPTION',
    'stdin throw',
  );
  assert.strictEqual(errorB.context.originalError, 'stdin is destroyed');
});

test('MCP client: a kill that throws is reported as KILL_ERROR, after the calls are rejected', async () => {
  const child = new FakeChild({ killError: new Error('ESRCH') });
  const errors = recordingOnError();
  const client = createMcpClient(
    {},
    { spawn: fakeSpawn(child), onError: errors, echoStderr: false },
  );

  const pending = client.callTool('one', {});
  client.close();

  const rejected = await expectFailure(
    pending,
    'CLIENT_CLOSED',
    'a call pending at a failing close',
  );
  assert.match(rejected.message, /client was closed/);

  const killErrors = errors.errors.filter(error => error.code === 'KILL_ERROR');
  assert.strictEqual(killErrors.length, 1, 'the failed kill is reported rather than swallowed');
  assert.strictEqual(killErrors[0].context.originalError, 'ESRCH');
  assert.strictEqual(client.isClosed(), true, 'the client is closed even when the kill failed');
});

/* -------------------------------------------------------------------------- *
 * Teardown leaves nothing referenced (#388)
 * -------------------------------------------------------------------------- */

test('MCP client: a closed client leaves no referenced timer behind', async () => {
  const child = new FakeChild();
  const client = createMcpClient(
    {},
    { spawn: fakeSpawn(child), killGraceMs: 30000, echoStderr: false },
  );

  const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  client.close();
  const afterClose = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

  // The grace timer is unref'd, so a closed client cannot hold the process open
  // for 30 seconds — which, before #388, was most of this suite's runtime.
  assert.ok(
    afterClose <= before,
    `close() must not add a referenced timer (before ${before}, after ${afterClose})`,
  );

  // And a child that exits promptly leaves no timer at all.
  child.emit('exit', 0, 'SIGTERM');
  const afterExit = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  assert.ok(
    afterExit <= before,
    `an exited child must not leave a timer behind (before ${before}, after ${afterExit})`,
  );
});

/* -------------------------------------------------------------------------- *
 * Benchmarks (#388)
 * -------------------------------------------------------------------------- */

/**
 * The two shapes a stdio client really sees, and why the framer exists.
 *
 * It is measured two ways, because one of them is not a race: characters
 * re-scanned is deterministic, while wall-clock is only asserted for the shape
 * where the difference is asymptotic and therefore far outside CI noise.
 */
test('LineFramer: measurably less work than the loop it replaced (#388)', () => {
  const scenarios = [
    {
      label: 'a burst of 200 small results',
      payload: ndjson(200, 2000),
      chunkSize: 1024,
      // Each read carries about one short line, so the undelivered tail is
      // bounded by the line length and the rescan overhead stays around 2x. The
      // two readers are therefore within noise of each other on time here, and
      // only the re-scan metric is asserted.
      minRescans: 1.5,
      maxTimeRatio: null,
    },
    {
      label: 'one 256 KiB tool result on a single line',
      payload: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] },
      })}\n`,
      chunkSize: 1024,
      // One long line in many small reads is the pathological case for the old
      // loop: it re-splits and re-copies everything not yet delivered on every
      // read, so the re-scan count grows with the message length over the read
      // size (here ~128x). Measured ~0.01 of the naive time, so half is a very
      // wide margin.
      minRescans: 50,
      maxTimeRatio: 0.5,
    },
  ];

  for (const { label, payload, chunkSize, minRescans, maxTimeRatio } of scenarios) {
    const chunks = chunkInto(payload, chunkSize);
    const inputBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
    assert.strictEqual(inputBytes, payload.length, 'the fixture must be delivered whole');

    // 1. Identical framing: a faster framer that frames differently is useless.
    const expected = [];
    const actual = [];
    const naive = measuringNaiveReader(line => expected.push(line));
    const framer = new LineFramer(line => actual.push(line));
    for (const chunk of chunks) {
      naive.push(chunk);
      framer.push(chunk);
    }
    assert.deepStrictEqual(actual, expected, `${label}: identical lines are a precondition`);

    // 2. Deterministic metric: characters re-scanned, versus the single pass
    //    the framer makes over the same bytes.
    const rescans = naive.scannedCharacters / inputBytes;
    assert.ok(
      rescans >= minRescans,
      `${label}: the naive reader should be re-scanning its undelivered tail ` +
        `(measured ${rescans.toFixed(1)}x the input, expected at least ${minRescans}x)`,
    );

    // 3. Wall-clock, asserted only where the difference dominates the noise.
    const naiveMs = fastestOf(5, () => {
      const reader = measuringNaiveReader(() => {});
      for (const chunk of chunks) reader.push(chunk);
    });
    const framerMs = fastestOf(5, () => {
      const reader = new LineFramer(() => {});
      for (const chunk of chunks) reader.push(chunk);
    });
    const ratio = framerMs / naiveMs;

    console.log(
      `    ${label} (${(inputBytes / 1024).toFixed(0)} KiB in ${chunks.length} reads): ` +
        `re-scan ${rescans.toFixed(0)}x input; naive ${naiveMs.toFixed(2)}ms, ` +
        `framer ${framerMs.toFixed(2)}ms, ratio ${ratio.toFixed(3)}`,
    );

    if (maxTimeRatio !== null) {
      assert.ok(
        ratio < maxTimeRatio,
        `${label}: the framer must be measurably faster (ratio ${ratio.toFixed(3)})`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- *
 * The CLI's spending controls, end to end and offline
 * -------------------------------------------------------------------------- */

/**
 * A mock paid resource. Every refusal asserted against it happens before the
 * CLI signs anything, which is what keeps these tests offline and instant.
 */
function startMockResources() {
  const server = http.createServer((req, res) => {
    const paymentRequired = amount =>
      JSON.stringify({
        error: 'payment_required',
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'stellar:testnet',
            price: { asset: 'native', amount },
            payTo: 'GBQ...',
          },
        ],
      });

    if (req.url === '/free') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('no payment needed');
      return;
    }
    if (req.url === '/priced-200') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(paymentRequired('200'));
      return;
    }
    if (req.url === '/priced-600') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(paymentRequired('600'));
      return;
    }
    if (req.url === '/no-accepts') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment_required', x402Version: 1, accepts: [] }));
      return;
    }
    if (req.url === '/bad-402') {
      // A 402 that is not a payment-required response at all.
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'gateway said no' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return {
    listen: () => new Promise(resolve => server.listen(0, () => resolve(server.address().port))),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Spawns the real MCP CLI with the given spend controls. */
function cliClient(env, options = {}) {
  const errors = recordingOnError();
  const client = createMcpClient(env, { timeout: 15000, onError: errors, ...options });
  return { client, errors };
}

test('MCP CLI spending controls: refusals are explicit, offline and before signing', async t => {
  const mock = startMockResources();
  const port = await mock.listen();
  const url = name => `http://localhost:${port}${name}`;

  // Caps with room: the per-call cap is 500, so a 200-stroop resource passes it
  // and the refusals below have to come from the checks further in.
  const roomy = cliClient({
    AGENT_PAYER_SECRET_KEY: TEST_PAYER_KEY,
    MAX_FEE_PER_CALL_STROOPS: '500',
    MAX_SESSION_SPEND_STROOPS: '1000',
  });
  // No session budget at all: the first priced call is refused by the session
  // check even though it fits the per-call cap.
  const noBudget = cliClient({
    AGENT_PAYER_SECRET_KEY: TEST_PAYER_KEY,
    MAX_FEE_PER_CALL_STROOPS: '500',
    MAX_SESSION_SPEND_STROOPS: '0',
  });
  // No payer configured: the tool refuses before it even fetches.
  const noPayer = cliClient({ AGENT_PAYER_SECRET_KEY: '', MAX_FEE_PER_CALL_STROOPS: '500' });

  t.after(() => {
    for (const { client } of [roomy, noBudget, noPayer]) if (!client.isClosed()) client.close();
    mock.close();
  });

  await t.test('enforces the per-call cap (600 > 500)', async () => {
    const error = await expectFailure(
      roomy.client.callTool('call_paid_resource', { url: url('/priced-600') }),
      'TOOL_CALL_FAILED',
      'over-cap call',
    );
    assert.match(error.message, /Spending refused.*exceeds per-call limit/);
  });

  await t.test('enforces the session budget before the per-call cap is relaxed', async () => {
    const error = await expectFailure(
      noBudget.client.callTool('call_paid_resource', { url: url('/priced-200') }),
      'TOOL_CALL_FAILED',
      'session-budget call',
    );
    assert.match(error.message, /Spending refused.*exceeds remaining session budget/);
    assert.match(
      error.message,
      /spent 0\/0 stroops/,
      'the refusal names the budget it compared against',
    );
  });

  await t.test('enforces a caller-supplied maxFeeStroops below the global cap', async () => {
    const error = await expectFailure(
      roomy.client.callTool('call_paid_resource', {
        url: url('/priced-200'),
        maxFeeStroops: '100',
      }),
      'TOOL_CALL_FAILED',
      'maxFeeStroops call',
    );
    assert.match(error.message, /exceeds requested maxFeeStroops/);
  });

  await t.test('an unpaid 200 is passed through without spending', async () => {
    const result = await roomy.client.callTool('call_paid_resource', { url: url('/free') });
    assert.strictEqual(result.isError, false);
    // The MCP server frames tool results as text content, so the CLI's object
    // arrives JSON-encoded inside it.
    const body = JSON.parse(result.content[0].text);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.status, 200);
    assert.strictEqual(body.response, 'no payment needed');
    assert.strictEqual(body.settlement, undefined, 'nothing was paid, so nothing settled');
  });

  await t.test('a 402 with no accepts is named as such', async () => {
    const error = await expectFailure(
      roomy.client.callTool('call_paid_resource', { url: url('/no-accepts') }),
      'TOOL_CALL_FAILED',
      '402 without requirements',
    );
    assert.match(error.message, /no payment accepts requirements/);
  });

  await t.test(
    'a 402 that is not a payment-required response reports a parse failure',
    async () => {
      const error = await expectFailure(
        roomy.client.callTool('call_paid_resource', { url: url('/bad-402') }),
        'TOOL_CALL_FAILED',
        'malformed 402',
      );
      assert.match(error.message, /Failed to parse payment requirements/);
    },
  );

  await t.test('without a payer key the paid tool refuses instead of half-paying', async () => {
    const error = await expectFailure(
      noPayer.client.callTool('call_paid_resource', { url: url('/priced-200') }),
      'TOOL_CALL_FAILED',
      'no payer key',
    );
    assert.match(error.message, /requires AGENT_PAYER_SECRET_KEY/);
  });
});

/* -------------------------------------------------------------------------- *
 * Coverage guard (#386) — must stay last: it reports on the whole file.
 * -------------------------------------------------------------------------- */

test('MCP client: every declared error code is exercised by this suite (#386)', () => {
  const missing = MCP_CLIENT_ERROR_CODES.filter(code => !observedCodes.has(code));
  const undeclared = [...observedCodes].filter(code => !MCP_CLIENT_ERROR_CODES.includes(code));

  assert.deepStrictEqual(
    missing,
    [],
    'these codes are declared by the client but no test produces them — add the test or delete the code',
  );
  assert.deepStrictEqual(
    undeclared,
    [],
    'these codes were reported by tests but are not declared in MCP_CLIENT_ERROR_CODES',
  );
  assert.strictEqual(
    observedCodes.size,
    MCP_CLIENT_ERROR_CODES.length,
    'the error-code surface is covered exhaustively',
  );
});
