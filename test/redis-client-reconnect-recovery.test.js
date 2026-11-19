/**
 * Redis disconnect/reconnect lifecycle (#763).
 *
 * The lazy-import branch of createRedisConnection registers 'error', 'ready'
 * and 'end' listeners. 'end' sets `ended`, and isUsable()/getClient() honour
 * it — but if 'ready' did not clear it, a single network blip or Redis restart
 * would leave the facilitator degraded for the life of the process, even
 * though ioredis had reconnected. These tests drive a real ioredis client
 * (against a local fake server, no Redis install) through end → ready and
 * assert the handle becomes usable again.
 *
 * The events are emitted on the client directly: 'end' on a real disconnect is
 * terminal for ioredis (it only reconnects from 'close'), which is exactly the
 * asymmetry that produced the bug. Emitting exercises the same listeners
 * createRedisConnection registered.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRedisConnection } from '../src/redis-client.js';

async function waitFor(fn, { timeout = 8000, interval = 25, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Keep polling; timeout reports the failure.
    }
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** Minimal RESP fake: enough for ioredis to settle into 'ready'. */
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

async function setUp() {
  const server = startFakeRedis();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const events = [];
  const conn = createRedisConnection({
    redisUrl: `redis://127.0.0.1:${port}`,
    onEvent: event => events.push(event),
  });
  const client = await conn.ready;
  await waitFor(() => client.status === 'ready', { what: 'initial ready' });
  await waitFor(() => conn.isUsable(), { what: 'initially usable' });

  const teardown = async () => {
    try {
      client.disconnect();
    } catch {
      // Already disconnected.
    }
    await new Promise(resolve => server.close(resolve)).catch(() => {});
  };
  return { conn, client, events, teardown };
}

const recoveredEvents = events => events.filter(e => e.type === 'recovered');

describe('redis-client reconnect recovery', () => {
  test('end then ready restores isUsable and getClient', async () => {
    const { conn, client, events, teardown } = await setUp();
    try {
      // Confirm the pre-existing degraded path still works.
      client.emit('error', new Error('connection reset'));
      await waitFor(() => events.some(e => e.type === 'degraded'), { what: 'degraded' });
      assert.equal(conn.isUsable(), false);

      // The socket closes: this sets the `ended` flag.
      client.emit('end');
      assert.equal(conn.isUsable(), false, 'ended connection must not be usable');
      assert.equal(conn.getClient(), null, 'ended connection must not hand out the client');

      // ioredis reconnects.
      client.emit('ready');

      assert.equal(conn.isUsable(), true, 'ready after end must restore isUsable');
      assert.equal(
        conn.getClient(),
        client,
        'ready after end must hand back the same live client instance',
      );
      assert.equal(recoveredEvents(events).length, 1, 'one recovery for one outage');
    } finally {
      await teardown();
    }
  });

  test('end alone (no prior degrade) is still cleared by ready', async () => {
    const { conn, client, events, teardown } = await setUp();
    try {
      // No 'error' first: ioredis can emit 'end' without a prior degrade, and
      // recovery must not depend on `degraded` having been set.
      client.emit('end');
      assert.equal(conn.isUsable(), false);
      assert.equal(conn.getClient(), null);

      client.emit('ready');
      assert.equal(conn.isUsable(), true);
      assert.equal(conn.getClient(), client);
      assert.equal(recoveredEvents(events).length, 1, 'the outage is reported once');
    } finally {
      await teardown();
    }
  });

  test('onRecover() clears ended for callers driving recovery themselves', async () => {
    const { conn, client, teardown } = await setUp();
    try {
      client.emit('end');
      assert.equal(conn.isUsable(), false);

      // The exported hook is what an external/injected client's owner calls;
      // it must clear both flags, not just degraded.
      conn.onRecover();

      assert.equal(conn.isUsable(), true);
      assert.equal(conn.getClient(), client);
    } finally {
      await teardown();
    }
  });

  test('repeated end/ready cycles each recover and stay quiet once healthy', async () => {
    const { conn, client, events, teardown } = await setUp();
    try {
      for (let i = 0; i < 3; i++) {
        client.emit('end');
        assert.equal(conn.isUsable(), false, `cycle ${i}: unusable while ended`);

        client.emit('ready');
        assert.equal(conn.isUsable(), true, `cycle ${i}: usable after ready`);
        assert.equal(conn.getClient(), client, `cycle ${i}: client restored`);
      }

      assert.equal(
        recoveredEvents(events).length,
        3,
        'each outage yields exactly one recovered event',
      );

      // A redundant ready while healthy still emits nothing and stays usable.
      client.emit('ready');
      assert.equal(conn.isUsable(), true);
      assert.equal(recoveredEvents(events).length, 3, 'no duplicate recovery events');
    } finally {
      await teardown();
    }
  });
});
