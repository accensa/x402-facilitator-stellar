/**
 * Batch-member frame isolation (#693).
 *
 * Concurrent batch members are kept apart by exactly one mechanism: the
 * `AsyncLocalStorage` sink read through `currentBatchSink()` and bound per
 * member with `await sinks.run(frames, () => dispatch(req))`. If that binding
 * weakened — `enterWith()` instead of `run()`, or the `await` dropped — a late
 * member would push its frames into a sibling's array and the batch would
 * answer with duplicated or misattributed ids.
 *
 * Existing coverage asserts whole-batch shape and cross-batch isolation, but
 * never releases two members of the same batch in opposite order, and never
 * runs a notification alongside a writer. Here each gated tool captures its
 * own sink array via `currentBatchSink()` and emits both a progress frame and
 * its `tools/call` result, so a leak is observable on ids, not just length.
 *
 * Ordering is driven by promise resolvers only — no timers — so the test is
 * deterministic on a loaded CI box. Every gate is released in `t.after`.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { currentBatchSink } from '../src/mcp/batch.js';

/** A promise plus its resolve function. */
function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A server whose tools block on per-key gates. Each handler records the sink
 * array it was given, emits a progress frame through the real send helper,
 * then returns its result (which the server emits as the second frame).
 */
function gatedServer() {
  const gates = new Map();
  const gateFor = key => {
    if (!gates.has(key)) {
      gates.set(key, {
        entered: deferred(),
        released: deferred(),
        finished: deferred(),
        frames: null,
      });
    }
    return gates.get(key);
  };

  const server = new McpServer({ name: 'batch-isolation-test', version: '0.0.1' });
  server.tool(
    'gated',
    { description: 'blocks until released, then emits two frames' },
    async args => {
      const gate = gateFor(args.key);
      gate.frames = currentBatchSink() ?? [];
      gate.entered.resolve();
      await gate.released.promise;
      // A real send helper inside the member: `_emit` hands this to the active
      // batch sink, so it lands in this member's array or nowhere.
      server._sendResult(`log-${args.key}`, {
        content: [{ type: 'text', text: `log:${args.key}` }],
        isError: false,
      });
      gate.finished.resolve();
      return `result:${args.key}`;
    },
  );
  server.tool(
    'silent',
    { description: 'blocks until released, then answers normally' },
    async args => {
      const gate = gateFor(args.key);
      gate.frames = currentBatchSink() ?? [];
      gate.entered.resolve();
      await gate.released.promise;
      gate.finished.resolve();
      return `silent:${args.key}`;
    },
  );

  return { server, gates, gateFor };
}

const call = (id, name, key) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: { key } },
});

describe('batch member sink isolation (#693)', () => {
  test('two gated members released in reverse order keep only their own frames', async t => {
    const { server, gates, gateFor } = gatedServer();
    t.after(() => {
      // A failing assertion must not leave a handler parked forever.
      for (const gate of gates.values()) gate.released.resolve();
    });

    const memberA = gateFor('a');
    const memberB = gateFor('b');
    const notification = gateFor('note');

    const run = server._runBatch([
      call('member-a', 'gated', 'a'),
      call('member-b', 'gated', 'b'),
      // A notification has no id: it runs concurrently but must emit nothing
      // and must not shift the ids the two requests receive.
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'silent', arguments: { key: 'note' } },
      },
    ]);

    // Both gated members are inside their handlers before either is released:
    // the batch is genuinely concurrent, not merely sequential.
    await Promise.all([
      memberA.entered.promise,
      memberB.entered.promise,
      notification.entered.promise,
    ]);
    assert.notEqual(memberA.frames, memberB.frames, 'each member gets its own sink array');

    // Notification first, then B, then A: reverse dispatch order for the two
    // requests. B runs to completion while A is still parked in its handler.
    notification.released.resolve();
    await notification.finished.promise;

    memberB.released.resolve();
    await memberB.finished.promise;

    assert.deepEqual(memberA.frames, [], 'A may not receive a frame while B runs');
    assert.deepEqual(
      memberB.frames.map(frame => frame.id),
      ['log-b'],
      'B holds only its own progress frame before its result is emitted',
    );

    memberA.released.resolve();
    await memberA.finished.promise;

    const out = await run;

    // Each member's own array: exactly its two frames, in emission order.
    assert.deepEqual(
      memberA.frames.map(frame => frame.id),
      ['log-a', 'member-a'],
      'member A holds exactly its progress frame and its result',
    );
    assert.deepEqual(
      memberB.frames.map(frame => frame.id),
      ['log-b', 'member-b'],
      'member B holds exactly its progress frame and its result',
    );
    assert.deepEqual(notification.frames, [], 'the notification member emits nothing');

    // The flattened wire output: request order, no duplicate, no leaked id.
    const ids = out.map(frame => frame.id);
    assert.deepEqual(ids, ['log-a', 'member-a', 'log-b', 'member-b']);
    assert.equal(new Set(ids).size, ids.length, 'no frame appears in both members');
    for (const frame of out) assert.equal(frame.error, undefined, 'no member failed');

    const resultA = out.find(frame => frame.id === 'member-a');
    const resultB = out.find(frame => frame.id === 'member-b');
    assert.equal(resultA.result.content[0].text, 'result:a');
    assert.equal(resultB.result.content[0].text, 'result:b');
    assert.equal(resultA.result.isError, false);
    assert.equal(resultB.result.isError, false);

    const logA = out.find(frame => frame.id === 'log-a');
    const logB = out.find(frame => frame.id === 'log-b');
    assert.equal(logA.result.content[0].text, 'log:a');
    assert.equal(logB.result.content[0].text, 'log:b');
  });

  test('releasing the later member first does not attribute its frames to the earlier one', async t => {
    const { server, gates, gateFor } = gatedServer();
    t.after(() => {
      for (const gate of gates.values()) gate.released.resolve();
    });

    const first = gateFor('first');
    const second = gateFor('second');
    const run = server._runBatch([call('one', 'gated', 'first'), call('two', 'gated', 'second')]);

    await Promise.all([first.entered.promise, second.entered.promise]);
    second.released.resolve();
    await second.finished.promise;
    first.released.resolve();
    await first.finished.promise;

    const out = await run;
    assert.deepEqual(
      first.frames.map(frame => frame.id),
      ['log-first', 'one'],
    );
    assert.deepEqual(
      second.frames.map(frame => frame.id),
      ['log-second', 'two'],
    );
    assert.deepEqual(
      out.map(frame => frame.id),
      ['log-first', 'one', 'log-second', 'two'],
    );
  });
});
