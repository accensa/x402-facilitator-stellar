import test from 'node:test';
import assert from 'node:assert';
import { processBatch, MAX_BATCH_SIZE, currentBatchSink } from '../src/mcp/batch.js';

// Dispatch function that follows JSON-RPC 2.0 spec and uses currentBatchSink
// - Notifications (no id, or id is null) produce no response
// - Successful requests push result frame to sink
// - Throwing requests push -32603 error frame to sink
function jsonRpcDispatch() {
  return async req => {
    // Notification: no id, or id is null - never answer
    if (req.id === undefined || req.id === null) {
      return;
    }
    const sink = currentBatchSink();
    if (sink) {
      // Simulate successful processing - push result frame
      sink.push({ jsonrpc: '2.0', id: req.id, result: 'success' });
    }
  };
}

// A dispatch that throws only for the first member, allowing neighbors to succeed
// This is used by the "rejecting member yields -32603 while neighbours unaffected" test
function firstMemberThrowsDispatch() {
  let firstCalled = true;
  return async req => {
    if (firstCalled) {
      firstCalled = false;
      // Throw an error - this will only affect the first member due to AsyncLocalStorage isolation
      throw new Error('dispatch error');
    }
    // Subsequent members succeed normally - push result frame directly
    const sink = currentBatchSink();
    if (sink) {
      sink.push({ jsonrpc: '2.0', id: req.id, result: 'success' });
    }
  };
}

function makeNotificationDispatchThrows() {
  return async () => {
    throw new Error('notification throws');
  };
}

function makeNotificationDispatchNoThrow() {
  return async () => {
    // notification with no id, no error - produces no response
  };
}

// Test 1: Empty batch returns single error frame with code -32600
test('empty batch returns single error frame with code -32600', async () => {
  const result = await processBatch([], jsonRpcDispatch());
  // Empty batch returns a single error frame object
  assert.strictEqual(result.error.code, -32600);
  assert.strictEqual(result.error.message, 'Invalid Request: batch must not be empty');
  assert.strictEqual(result.id, null);
  assert.strictEqual(result.jsonrpc, '2.0');
});

// Test 2: Oversized batch (exceeds MAX_BATCH_SIZE) returns single error frame
test('oversized batch returns single error frame with code -32600', async () => {
  const bigBatch = new Array(MAX_BATCH_SIZE + 1).fill({ jsonrpc: '2.0', method: 'test' });
  const result = await processBatch(bigBatch, jsonRpcDispatch());
  // Oversized batch returns a single error frame object
  assert.strictEqual(result.error.code, -32600);
  assert.strictEqual(
    result.error.message,
    `Invalid Request: batch of ${MAX_BATCH_SIZE + 1} exceeds the maximum of ${MAX_BATCH_SIZE} requests`,
  );
  assert.strictEqual(result.id, null);
});

// Test 3: Oversized batch with custom maxSize
test('oversized batch with custom maxSize respects the custom limit', async () => {
  const batchOf30 = new Array(30).fill({ jsonrpc: '2.0', method: 'test' });
  const result = await processBatch(batchOf30, jsonRpcDispatch(), { maxSize: 20 });
  // Oversized batch with custom maxSize returns a single error frame object
  assert.strictEqual(result.error.code, -32600);
  assert.strictEqual(
    result.error.message,
    `Invalid Request: batch of 30 exceeds the maximum of 20 requests`,
  );
});

// Test 4: null member returns Invalid Request frame with its id (null)
test('null member returns Invalid Request frame', async () => {
  const result = await processBatch([null], jsonRpcDispatch());
  // Single member batch returns an array of responses
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].jsonrpc, '2.0');
  assert.strictEqual(result[0].error.code, -32600);
  assert.strictEqual(result[0].error.message, 'Invalid Request');
  // id should be null for null member
  assert.strictEqual(result[0].id, null);
});

// Test 5: number member returns Invalid Request frame
test('number member returns Invalid Request frame', async () => {
  const result = await processBatch([42], jsonRpcDispatch());
  // Single member batch returns an array of responses
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].error.code, -32600);
  assert.strictEqual(result[0].error.message, 'Invalid Request');
});

// Test 6: object with id but no method returns Invalid Request frame
test('object with id but no method returns Invalid Request frame', async () => {
  const result = await processBatch([{ id: 'test-id' }], jsonRpcDispatch());
  // Single member batch returns an array of responses
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].error.code, -32600);
  assert.strictEqual(result[0].error.message, 'Invalid Request');
  assert.strictEqual(result[0].id, 'test-id');
});

// Test 7: notification-only batch (no id) returns empty array
test('notification-only batch returns empty array', async () => {
  const result = await processBatch(
    [{ jsonrpc: '2.0', method: 'notifications/test' }],
    jsonRpcDispatch(),
  );
  assert.strictEqual(result.length, 0);
});

// Test 8: mixed batch returns frames only for id-bearing requests
test('mixed batch returns frames only for id-bearing requests', async () => {
  const mixed = [
    { jsonrpc: '2.0', method: 'test1' }, // notification, no id
    { jsonrpc: '2.0', id: 'req2', method: 'test2' }, // id-bearing
    { jsonrpc: '2.0', method: 'test3' }, // notification, no id
    { jsonrpc: '2.0', id: 'req4', method: 'test4' }, // id-bearing
  ];
  const result = await processBatch(mixed, jsonRpcDispatch());
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].id, 'req2');
  assert.strictEqual(result[1].id, 'req4');
});

// Test 9: rejecting member yields -32603 while neighbours are unaffected
test('rejecting member yields -32603 while neighbours unaffected', async () => {
  const mixed = [
    { jsonrpc: '2.0', id: 'first', method: 'test1' },
    { jsonrpc: '2.0', id: 'second', method: 'test2' },
    { jsonrpc: '2.0', id: 'third', method: 'test3' },
  ];

  const results = await processBatch(mixed, firstMemberThrowsDispatch(), { maxSize: 10 });

  // All three should have responses (none dropped)
  assert.strictEqual(results.length, 3);

  // First member should have -32603 error
  assert.strictEqual(results[0].error.code, -32603);

  // Second member should still have its response unaffected
  assert.strictEqual(results[1].error, undefined);
  assert.strictEqual(results[1].id, 'second');

  // Third member should still have its response unaffected
  assert.strictEqual(results[2].error, undefined);
  assert.strictEqual(results[2].id, 'third');
});

// Test 10: AsyncLocalStorage sink keeps concurrent members from writing into each other's frame list
test("AsyncLocalStorage sink keeps concurrent members from writing into each other's frames", async () => {
  const concurrent = [
    { jsonrpc: '2.0', id: 'concurrent1', method: 'test1' },
    { jsonrpc: '2.0', id: 'concurrent2', method: 'test2' },
  ];

  const results = await processBatch(concurrent, jsonRpcDispatch());

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].id, 'concurrent1');
  assert.strictEqual(results[0].result, 'success');
  assert.strictEqual(results[1].id, 'concurrent2');
  assert.strictEqual(results[1].result, 'success');
});

// Test 11: empty array member
test('empty array member returns Invalid Request frame', async () => {
  const result = await processBatch([[]], jsonRpcDispatch());
  // Single member batch returns an array of responses
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].error.code, -32600);
  assert.strictEqual(result[0].error.message, 'Invalid Request');
});

// Test 12: object without id and without method
test('object without id and without method returns Invalid Request frame', async () => {
  const result = await processBatch([{}], jsonRpcDispatch());
  // Single member batch returns an array of responses
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].error.code, -32600);
  assert.strictEqual(result[0].error.message, 'Invalid Request');
  assert.strictEqual(result[0].id, null);
});

// Test 13: String member (not an object)
test('string member returns Invalid Request frame', async () => {
  const result = await processBatch(['hello'], jsonRpcDispatch());
  // Single member batch returns an array of responses
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].error.code, -32600);
  assert.strictEqual(result[0].error.message, 'Invalid Request');
  assert.strictEqual(result[0].id, null);
});

// Test 14: notification that throws is answered with nothing
test('notification that throws is answered with nothing', async () => {
  const result = await processBatch(
    [{ jsonrpc: '2.0', method: 'notifications/throw' }],
    makeNotificationDispatchThrows(),
  );
  assert.strictEqual(result.length, 0);
});

// Test 15: notification that does not throw returns nothing
test('notification that does not throw returns nothing', async () => {
  const result = await processBatch(
    [{ jsonrpc: '2.0', method: 'notifications/quiet' }],
    makeNotificationDispatchNoThrow(),
  );
  assert.strictEqual(result.length, 0);
});

// Test 16: batch with custom maxSize smaller than MAX_BATCH_SIZE
test('batch respects custom maxSize smaller than MAX_BATCH_SIZE', async () => {
  const batchOf30 = new Array(30).fill({ jsonrpc: '2.0', method: 'test' });
  const result = await processBatch(batchOf30, jsonRpcDispatch(), { maxSize: 15 });
  // Oversized batch with custom maxSize returns a single error frame object
  assert.strictEqual(result.error.code, -32600);
  assert.strictEqual(
    result.error.message,
    `Invalid Request: batch of 30 exceeds the maximum of 15 requests`,
  );
});

// Test 17: exactly MAX_BATCH_SIZE accepted (with ids - these are requests, not notifications)
test('exactly MAX_BATCH_SIZE requests are accepted', async () => {
  const batch = new Array(MAX_BATCH_SIZE).fill({
    jsonrpc: '2.0',
    id: 'req-' + MAX_BATCH_SIZE,
    method: 'test',
  });
  const result = await processBatch(batch, jsonRpcDispatch());
  // Full batch returns an array of responses
  assert.strictEqual(result.length, MAX_BATCH_SIZE);
});

// Test 17b: exactly MAX_BATCH_SIZE + 1 requests are rejected
test('exactly MAX_BATCH_SIZE + 1 requests are rejected', async () => {
  const batch = new Array(MAX_BATCH_SIZE + 1).fill({ jsonrpc: '2.0', method: 'test' });
  const result = await processBatch(batch, jsonRpcDispatch());
  // Oversized batch returns a single error frame object
  assert.strictEqual(result.error.code, -32600);
});

// Test 18: single request (not a batch) works
test('single request works', async () => {
  const result = await processBatch(
    [{ jsonrpc: '2.0', id: 'test', method: 'test' }],
    jsonRpcDispatch(),
  );
  // Single element batch returns an array with one response
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'test');
});

// Test 19: notification with id: null produces no response (treated as notification)
test('notification with id: null produces no response', async () => {
  // id: null is treated as a notification (no response)
  const result = await processBatch(
    [{ jsonrpc: '2.0', id: null, method: 'test' }],
    jsonRpcDispatch(),
  );
  assert.strictEqual(result.length, 0);
});
