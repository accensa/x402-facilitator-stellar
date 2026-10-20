import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRedisConnection } from '../src/redis-client.js';

/**
 * Event-wiring tests for the lazy-import Redis path (src/redis-client.js:87).
 *
 * The production degrade/recover path is three ioredis listeners registered
 * only on the lazy-import branch (error at :87, ready at :88, end at :89-91).
 * Every existing test bypassed them -- chaos tests call _recover() directly
 * and rate-limit tests inject a plain object -- so a regression in the glue
 * that flips isUsable/getClient would stick the limiter in per-instance
 * degrade forever (or keep using a dead client) with CI green. These tests
 * drive createRedisConnection against the real ioredis package pointed at a
 * controllable 127.0.0.1 port, with no external Redis.
 */

async function waitFor(fn, { timeout = 5000, interval = 25, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Keep polling; the last error is reported on timeout.
    }
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/**
 * Minimal fake Redis that speaks just enough RESP for ioredis to reach
 * ready: HELLO 3 is answered with an unknown-command error so the client
 * downgrades to RESP2, SETINFO answers +OK, and INFO answers loading:0.
 * Localhost-only, no Docker, no toxiproxy.
 */
function startFakeRedis() {
  const server = net.createServer(socket => {
    socket.on('data', chunk => {
      const text = chunk.toString();
      const lower = text.toLowerCase();
      if (lower.includes('hello')) {
        socket.write("-ERR unknown command 'hello'\r\n+OK\r\n+OK\r\n");
      } else if (text.includes('$4\r\ninfo')) {
        const info = 'loading:0';
        socket.write(`$${info.length}\r\n${info}\r\n`);
      } else if (lower.includes('setinfo')) {
        const count = lower.split('setinfo').length - 1;
        socket.write('+OK\r\n'.repeat(count));
      } else {
        socket.write('+OK\r\n');
      }
    });
  });
  return server;
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  await new Promise(resolve => server.close(resolve));
}

describe('redis-client lazy-import event wiring', () => {
  test('connection refused produces degraded carrying the message', async () => {
    const port = await freePort();
    const events = [];
    const conn = createRedisConnection({
      redisUrl: `redis://127.0.0.1:${port}`,
      onEvent: event => events.push(event),
    });
    const client = await conn.ready;
    assert.ok(client, 'lazy import resolves a client even when refused');
    try {
      const degraded = await waitFor(() => events.find(e => e.type === 'degraded'), {
        timeout: 8000,
        what: 'degraded after ECONNREFUSED',
      });
      assert.match(degraded.message, /Redis error:/);
      assert.equal(conn.isUsable(), false);
      assert.equal(conn.getClient(), null);
    } finally {
      client.disconnect();
    }
  });

  test('fake server accept recovers and flips isUsable/getClient back', async () => {
    const port = await freePort();
    const events = [];
    const conn = createRedisConnection({
      redisUrl: `redis://127.0.0.1:${port}`,
      onEvent: event => events.push(event),
    });
    const client = await conn.ready;
    const server = startFakeRedis();
    try {
      await waitFor(() => events.find(e => e.type === 'degraded'), {
        timeout: 8000,
        what: 'initial degraded',
      });
      assert.equal(conn.isUsable(), false);

      await listen(server, port);
      const recovered = await waitFor(() => events.find(e => e.type === 'recovered'), {
        timeout: 15000,
        what: 'recovered after fake accept',
      });
      assert.equal(recovered.type, 'recovered');
      assert.equal(conn.isUsable(), true, 'recovered must flip isUsable back');
      assert.ok(conn.getClient(), 'recovered must flip getClient back');
    } finally {
      client.disconnect();
      await closeServer(server).catch(() => {});
    }
  });

  test('disconnect fires end, making isUsable false and getClient null', async () => {
    const server = startFakeRedis();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const events = [];
    const conn = createRedisConnection({
      redisUrl: `redis://127.0.0.1:${port}`,
      onEvent: event => events.push(event),
    });
    const client = await conn.ready;
    try {
      await waitFor(() => client.status === 'ready', { timeout: 8000, what: 'fake ready' });
      assert.equal(conn.isUsable(), true);

      client.disconnect();
      await waitFor(() => conn.isUsable() === false, {
        timeout: 5000,
        what: 'isUsable false after end',
      });
      assert.equal(conn.getClient(), null);
    } finally {
      try {
        client.disconnect();
      } catch {
        // Already disconnected.
      }
      await closeServer(server).catch(() => {});
    }
  });

  test('warn-once: two errors emit one degraded; ready without degrade emits nothing', async () => {
    const server = startFakeRedis();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const events = [];
    const conn = createRedisConnection({
      redisUrl: `redis://127.0.0.1:${port}`,
      onEvent: event => events.push(event),
    });
    const client = await conn.ready;
    try {
      await waitFor(() => client.status === 'ready', { timeout: 8000, what: 'fake ready' });
      // A ready with no prior degrade is quiet.
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(events, [], 'ready without a prior degrade must emit nothing');

      client.emit('error', new Error('boom-1'));
      await waitFor(() => events.filter(e => e.type === 'degraded').length >= 1, {
        timeout: 2000,
        what: 'first degraded',
      });
      client.emit('error', new Error('boom-2'));
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(
        events.filter(e => e.type === 'degraded').length,
        1,
        'two consecutive errors emit one degraded',
      );

      client.emit('ready');
      await waitFor(() => events.filter(e => e.type === 'recovered').length >= 1, {
        timeout: 2000,
        what: 'recovered',
      });
      client.emit('ready');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(
        events.filter(e => e.type === 'recovered').length,
        1,
        'a second ready without a degrade emits nothing',
      );
    } finally {
      client.disconnect();
      await closeServer(server).catch(() => {});
    }
  });

  test('bad url emits unavailable rather than throwing', async () => {
    const events = [];
    // A malformed URL makes `new Redis` throw synchronously, exercising the
    // same catch as an unresolvable ioredis import (:93-95).
    const conn = createRedisConnection({ redisUrl: '::::', onEvent: e => events.push(e) });
    const client = await conn.ready;
    assert.equal(client, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'unavailable');
    assert.match(events[0].message, /Redis unavailable/);
    assert.equal(conn.isUsable(), false);
  });
});
