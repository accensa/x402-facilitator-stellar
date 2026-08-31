import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { McpServer } from '../src/mcp/server.js';

/**
 * Wire-level tests for the stdio transport (#197, #198, #199).
 *
 * The dispatch-level error contract lives in test/mcp-server.test.js; these
 * tests own the transport around it: writes that respect backpressure,
 * responses that never interleave, notifications that are never answered, and
 * frames that are answered rather than ignored.
 */

// 2 MiB of payload — far past any OS pipe buffer (64 KiB on Linux/macOS), so a
// real stdio client would be deep into write()-returning-false territory.
const BIG = 'x'.repeat(2 * 1024 * 1024);

/**
 * Stdout stand-in that records chunks. `allow = false` makes write() return
 * false exactly like a full pipe buffer does, and a later emit('drain')
 * releases the queue — the same protocol a real stream speaks.
 */
class FakeStdout extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.buffered = []; // what a real stream holds between write()=false and 'drain'
    this.allow = true;
  }

  write(chunk) {
    if (!this.allow) {
      // A real stream QUEUES the chunk internally and returns false — the
      // caller must not re-write it. 'drain' means that queue emptied.
      this.buffered.push(chunk);
      return false;
    }
    this.chunks.push(chunk);
    return true;
  }

  emit(event, ...args) {
    if (event === 'drain') {
      this.chunks.push(...this.buffered);
      this.buffered = [];
      this.allow = true;
    }
    return super.emit(event, ...args);
  }

  text() {
    return this.chunks.join('');
  }

  /**
   * Parsed JSON messages. Throws if two responses share a line — i.e. if a
   * write ever interleaved with another, which is the #197 failure mode.
   */
  messages() {
    return this.text()
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }
}

async function setup() {
  const stdin = new PassThrough();
  const stdout = new FakeStdout();
  const server = new McpServer({ name: 'transport-test', version: '0.0.1' });
  server.tool('small', { description: 'tiny result' }, async () => 'ok');
  server.tool('big', { description: 'huge result' }, async () => BIG);
  server.tool('crash', { description: 'internal failure' }, async () => {
    throw new Error('internal boom');
  });
  await server.start({ stdin, stdout });
  const send = value => stdin.write(`${JSON.stringify(value)}\n`);
  return { server, stdin, stdout, send };
}

async function until(fn, what, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const messagesSoon = (stdout, n) =>
  until(() => {
    try {
      return stdout.messages().length >= n;
    } catch {
      return false;
    }
  }, `${n} parseable messages`);

test('#197: a payload far past the pipe buffer round-trips as exactly one message', async () => {
  const { send, stdout } = await setup();
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'big', arguments: {} } });
  await messagesSoon(stdout, 1);

  const msgs = stdout.messages(); // JSON.parse per line — a torn write fails here
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, 1);
  assert.equal(msgs[0].result.content[0].text.length, BIG.length);
  assert.equal(msgs[0].result.content[0].text, BIG, 'payload intact head to tail');
});

test('#197: concurrent requests never interleave and answer in request order', async () => {
  const { send, stdout } = await setup();
  // Back to back: both are in flight before either handler has finished.
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'big', arguments: {} } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'small', arguments: {} } });
  await messagesSoon(stdout, 2);

  const msgs = stdout.messages();
  assert.deepEqual(
    msgs.map(m => m.id),
    [1, 2],
    'response order follows request order',
  );
  assert.equal(msgs[0].result.content[0].text, BIG);
  assert.equal(msgs[1].result.content[0].text, 'ok');
});

test('#197: a backpressured stdout parks writes until drain, in order', async () => {
  const { send, stdout, server } = await setup();
  stdout.allow = false; // the pipe is full
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'small', arguments: {} } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'small', arguments: {} } });
  await until(() => server._drain instanceof Promise, 'the write queue to form');
  await new Promise(resolve => setTimeout(resolve, 25)); // both handlers done, writes parked

  assert.equal(stdout.chunks.length, 0, 'nothing may reach a full pipe');

  stdout.allow = true;
  stdout.emit('drain');
  await server.flush();

  const msgs = stdout.messages();
  assert.deepEqual(
    msgs.map(m => m.id),
    [1, 2],
    'parked responses flush in order',
  );
});

test('#197: EPIPE on stdout stops the server cleanly instead of crashing', async () => {
  const { send, stdout, server } = await setup();
  stdout.allow = false;
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'small', arguments: {} } });
  await until(() => server._drain instanceof Promise, 'the write queue to form');
  await new Promise(resolve => setTimeout(resolve, 25));

  // Client vanished mid-write. On a stream with no 'error' listener this emit
  // raises an unhandled error event — so the assertions below hold only if
  // the server actually handles it.
  stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

  // The parked queue was released and the server stopped accepting work.
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'small', arguments: {} } });
  await server.flush();
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(stdout.chunks.length, 0, 'a closed server writes nothing more');
  assert.equal(stdout.listeners('drain').length, 0, 'no parked write stays stuck on drain');
});

test('#198: the initialize handshake works and failing notifications stay silent', async () => {
  const { send, stdout, server } = await setup();
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // the notification every client sends
  send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'crash', arguments: {} } }); // notification whose handler throws
  send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  await messagesSoon(stdout, 2);
  await server.flush();
  await new Promise(resolve => setTimeout(resolve, 10));

  const msgs = stdout.messages();
  assert.deepEqual(
    msgs.map(m => m.id),
    [1, 2],
    'only requests with ids are answered',
  );
  assert.equal(msgs[0].result.serverInfo.name, 'transport-test');
  assert.ok(!stdout.text().includes('"error"'), 'no error frame may be emitted for a notification');
  for (const m of msgs) assert.notEqual(m.id, undefined, 'every emitted frame carries an id');
});

test('#199: batches and malformed frames are answered, never ignored', async () => {
  const { send, stdin, stdout, server } = await setup();
  // A valid batch: two requests, one of them a notification.
  send([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]);
  send([]); // empty batch
  send([{ jsonrpc: '2.0', method: 'ping' }]); // batch of only notifications
  send('hello'); // valid JSON, not a request object
  send(42); // ditto
  stdin.write('this is not json\n'); // parse error
  await server.flush();
  await new Promise(resolve => setTimeout(resolve, 10));

  const msgs = stdout.messages();
  assert.deepEqual(
    msgs.map(m => m.error.code),
    [-32600, -32600, -32600, -32600, -32600, -32700],
    'every rejected frame gets an explicit response',
  );
  assert.match(msgs[0].error.message, /batch/i);
  for (const m of msgs) assert.equal(m.id, null, 'undetectable ids surface as null per JSON-RPC');
});
