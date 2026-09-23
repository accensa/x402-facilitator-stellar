/**
 * Process-level error handlers (#205).
 *
 * The unit tests inject a logger and an exit function so the handler behaviour
 * is observable without killing the test runner. The last test is the real
 * thing: it boots `src/server.js` on an already-bound port and asserts the
 * process reports the failure and exits non-zero, rather than disappearing
 * silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createProcessErrorHandlers,
  installProcessErrorHandlers,
} from '../src/process-handlers.js';

function harness() {
  const target = new EventEmitter();
  const logs = [];
  const exits = [];
  installProcessErrorHandlers(target, {
    log: message => logs.push(message),
    exit: code => exits.push(code),
  });
  return { target, logs, exits };
}

test('an unhandled rejection is logged with its stack and exits non-zero', () => {
  const { target, logs, exits } = harness();
  target.emit('unhandledRejection', new Error('stray rejection'));

  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[Fatal\] Unhandled promise rejection/);
  assert.match(logs[0], /stray rejection/);
  assert.deepEqual(exits, [1]);
});

test('an uncaught exception is logged with its stack and exits non-zero', () => {
  const { target, logs, exits } = harness();
  target.emit('uncaughtException', new Error('boom'));

  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[Fatal\] Uncaught exception/);
  assert.match(logs[0], /boom/);
  assert.deepEqual(exits, [1]);
});

test('a non-Error reason is stringified rather than dropped', () => {
  const { target, logs, exits } = harness();
  target.emit('unhandledRejection', 'a plain string');

  assert.match(logs[0], /a plain string/);
  assert.deepEqual(exits, [1]);
});

test('a second fatal event while handling the first is ignored', () => {
  const { target, logs, exits } = harness();
  target.emit('unhandledRejection', new Error('first'));
  target.emit('uncaughtException', new Error('second'));

  assert.equal(logs.length, 1, 'one diagnostic line, not two');
  assert.equal(logs[0].includes('second'), false);
  assert.deepEqual(exits, [1], 'exit is requested exactly once');
});

test('createProcessErrorHandlers is independent of any global process object', () => {
  const logs = [];
  const exits = [];
  const handlers = createProcessErrorHandlers({
    log: message => logs.push(message),
    exit: code => exits.push(code),
  });
  handlers.onUncaughtException(new Error('isolated'));

  assert.equal(logs.length, 1);
  assert.deepEqual(exits, [1]);
});

test('server.js reports a bind failure and exits non-zero instead of dying silently', async t => {
  // Hold a port, then ask the server to bind it. 0.0.0.0 conflicts with the
  // held 127.0.0.1 binding, producing EADDRINUSE.
  const blocker = net.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const port = blocker.address().port;
  t.after(() => blocker.close());

  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/server.js', import.meta.url))],
    {
      env: {
        ...process.env,
        NODE_ENV: 'production', // skip .env loading
        TRACING_ENABLED: 'false',
        PORT: String(port),
        // A well-formed (unfunded) testnet key: config must accept it so the
        // failure under test is the bind, not configuration.
        FACILITATOR_SECRET: 'SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const exited = await Promise.race([
    once(child, 'exit').then(([code]) => code),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000)).then(outcome => {
      if (outcome === 'timeout') child.kill('SIGKILL');
      return outcome;
    }),
  ]);

  assert.notEqual(exited, 'timeout', `server did not exit; stderr:\n${stderr}`);
  assert.notEqual(exited, 0, `a bind failure must exit non-zero; stderr:\n${stderr}`);
  assert.match(stderr, /\[Fatal\] failed to listen/);
  assert.match(stderr, /EADDRINUSE/);
});
