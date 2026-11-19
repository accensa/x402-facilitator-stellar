/**
 * Contract tests for the JSON-RPC batch rules in src/mcp/batch.js (#571).
 *
 * The module's header is the specification: notifications produce no response,
 * a notification-only batch produces nothing, members are dispatched
 * independently, and every response carries the id of the request it answers.
 * Those rules are asserted here against processBatch directly, using a
 * dispatch stub that writes through currentBatchSink() exactly as the server's
 * send helpers do. No network, no server, no timers.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BATCH_SIZE, currentBatchSink, processBatch } from '../src/mcp/batch.js';

const request = (id, method = 'ping') => ({ jsonrpc: '2.0', id, method });

/** A frame the server would have written for this request. */
const frame = req => ({ jsonrpc: '2.0', id: req.id, result: { method: req.method } });

/**
 * Mirrors the server's send helpers: the active member's frame is pushed to
 * the sink, and a notification (no id) writes nothing.
 */
function makeDispatch() {
  const calls = [];
  const dispatch = async req => {
    calls.push(req);
    const sink = currentBatchSink();
    assert.ok(Array.isArray(sink), 'dispatch must run inside a batch member sink');
    if (req.id !== undefined) sink.push(frame(req));
  };
  return { dispatch, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const requests = (count, start = 0) =>
  Array.from({ length: count }, (_, index) => request(start + index));

describe('processBatch (#571)', () => {
  test('an empty batch is refused as a single -32600 frame and dispatches nothing', async () => {
    const { dispatch, calls } = makeDispatch();
    const out = await processBatch([], dispatch);

    assert.equal(Array.isArray(out), false);
    assert.equal(out.id, null);
    assert.equal(out.error.code, -32600);
    assert.match(out.error.message, /batch must not be empty/);
    assert.equal(calls.length, 0);
  });

  test('the default limit accepts 25 requests and refuses 26 with both numbers', async () => {
    assert.equal(MAX_BATCH_SIZE, 25, 'the documented default is part of this contract');

    const accepted = makeDispatch();
    const atLimit = await processBatch(requests(25), accepted.dispatch);
    assert.equal(accepted.calls.length, 25);
    assert.deepEqual(
      atLimit.map(response => response.id),
      requests(25).map(req => req.id),
    );

    const refused = makeDispatch();
    const overLimit = await processBatch(requests(26), refused.dispatch);
    assert.equal(refused.calls.length, 0, 'an oversized batch is refused before dispatch');
    assert.equal(Array.isArray(overLimit), false);
    assert.equal(overLimit.id, null);
    assert.equal(overLimit.error.code, -32600);
    assert.match(overLimit.error.message, /26.*maximum of 25/);
  });

  test('a custom maxSize is enforced at its own boundary', async () => {
    const accepted = makeDispatch();
    const atLimit = await processBatch(requests(2), accepted.dispatch, { maxSize: 2 });
    assert.equal(atLimit.length, 2);
    assert.equal(accepted.calls.length, 2);

    const refused = makeDispatch();
    const overLimit = await processBatch(requests(3), refused.dispatch, { maxSize: 2 });
    assert.equal(refused.calls.length, 0);
    assert.equal(overLimit.error.code, -32600);
    assert.match(overLimit.error.message, /3.*maximum of 2/);
  });

  test('null, numbers and method-less objects get Invalid Request frames with their id', async () => {
    const { dispatch, calls } = makeDispatch();
    const out = await processBatch([null, 42, { jsonrpc: '2.0', id: 'no-method' }], dispatch);

    assert.equal(calls.length, 0, 'invalid members are answered without dispatch');
    assert.deepEqual(
      out.map(response => response.id),
      [null, null, 'no-method'],
    );
    for (const response of out) {
      assert.equal(response.error.code, -32600);
      assert.equal(response.error.message, 'Invalid Request');
    }
  });

  test('a notification-only batch produces an empty array', async () => {
    const { dispatch, calls } = makeDispatch();
    const out = await processBatch(
      [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
      dispatch,
    );

    assert.ok(Array.isArray(out));
    assert.deepEqual(out, []);
    assert.equal(calls.length, 1, 'the notification is still dispatched');
  });

  test('a mixed batch answers only id-bearing requests, in request order, despite out-of-order completion', async () => {
    const gates = new Map();
    const dispatch = req => {
      if (req.id === undefined) return Promise.resolve();
      const gate = deferred();
      gates.set(req.id, gate);
      return gate.promise.then(() => currentBatchSink().push(frame(req)));
    };

    const running = processBatch(
      [request(1), { jsonrpc: '2.0', method: 'notifications/initialized' }, request(2), request(3)],
      dispatch,
    );

    // All members have started and are parked on their gates; finish 3, 1, 2.
    gates.get(3).resolve();
    gates.get(1).resolve();
    gates.get(2).resolve();

    const out = await running;
    assert.deepEqual(
      out.map(response => response.id),
      [1, 2, 3],
    );
  });

  test('a rejecting request yields -32603 with its message in error.data; neighbours are unaffected', async () => {
    const dispatch = async req => {
      if (req.method === 'explode') throw new Error('kaboom');
      if (req.id !== undefined) currentBatchSink().push(frame(req));
    };

    const out = await processBatch(
      [request(1), { ...request(2), method: 'explode' }, request(3)],
      dispatch,
    );

    assert.deepEqual(
      out.map(response => response.id),
      [1, 2, 3],
    );
    assert.deepEqual(out[0].result, { method: 'ping' });
    assert.equal(out[1].error.code, -32603);
    assert.equal(out[1].error.message, 'Internal error');
    assert.equal(out[1].error.data, 'kaboom');
    assert.deepEqual(out[2].result, { method: 'ping' });
  });

  test('a throwing notification is never answered, even beside a request', async () => {
    const dispatch = async req => {
      if (req.method === 'explode') throw new Error('notification kaboom');
      if (req.id !== undefined) currentBatchSink().push(frame(req));
    };

    assert.deepEqual(await processBatch([{ jsonrpc: '2.0', method: 'explode' }], dispatch), []);

    const out = await processBatch([{ jsonrpc: '2.0', method: 'explode' }, request(9)], dispatch);
    assert.deepEqual(
      out.map(response => response.id),
      [9],
    );
  });

  test("concurrent members never see each other's frames", async () => {
    const gates = new Map();
    const seen = new Map();
    const dispatch = async req => {
      const sink = currentBatchSink();
      seen.set(req.id, sink);
      sink.push({ ...frame(req), result: { step: 'start' } });

      const gate = deferred();
      gates.set(req.id, gate);
      await gate.promise;
      sink.push({ ...frame(req), result: { step: 'end' } });
    };

    const running = processBatch([request('slow'), request('fast')], dispatch);

    // Both members are in flight before either finishes.
    gates.get('fast').resolve();
    await Promise.resolve();

    assert.deepEqual(
      seen.get('slow').map(response => [response.id, response.result.step]),
      [['slow', 'start']],
      'the still-running member sees none of the finished member frames',
    );
    assert.deepEqual(
      seen.get('fast').map(response => [response.id, response.result.step]),
      [
        ['fast', 'start'],
        ['fast', 'end'],
      ],
    );

    gates.get('slow').resolve();

    const out = await running;

    assert.notEqual(seen.get('slow'), seen.get('fast'), 'each member owns a distinct sink');
    assert.deepEqual(
      seen.get('slow').map(response => [response.id, response.result.step]),
      [
        ['slow', 'start'],
        ['slow', 'end'],
      ],
    );
    assert.deepEqual(
      seen.get('fast').map(response => [response.id, response.result.step]),
      [
        ['fast', 'start'],
        ['fast', 'end'],
      ],
    );
    assert.deepEqual(
      out.map(response => [response.id, response.result.step]),
      [
        ['slow', 'start'],
        ['slow', 'end'],
        ['fast', 'start'],
        ['fast', 'end'],
      ],
    );
  });
});
