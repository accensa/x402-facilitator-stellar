/**
 * Sandbox handlers that return `undefined` (#767).
 *
 * Both execution paths checked `JSON.stringify(result).length` unguarded. When a
 * handler returns `undefined`, `JSON.stringify` returns `undefined`, so the
 * `.length` access threw a TypeError — in the worker as a rejected run, directly
 * as an unhandled error. These tests cover both paths, plus that real payloads
 * are still size-checked.
 *
 * `executeInSandbox` only takes the direct path when it is not running on the
 * main thread, so the direct-mode cases run inside a worker thread.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { executeInSandbox } from '../src/mcp/security.js';

const securityModuleUrl = new URL('../src/mcp/security.js', import.meta.url).href;

/**
 * Runs scenarios through the direct (non-worker) path inside a worker thread,
 * where `isMainThread` is false.
 */
function runDirectScenarios() {
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');

    (async () => {
      const { executeInSandbox } = await import(workerData.moduleUrl);
      const settle = async run => {
        try {
          return { ok: true, value: await run() };
        } catch (err) {
          return { ok: false, name: err.name, message: err.message, field: err.field };
        }
      };

      const outcomes = {};
      outcomes.undefinedSync = await settle(() => executeInSandbox(() => undefined, {}));
      outcomes.undefinedAsync = await settle(() =>
        executeInSandbox(async () => undefined, {}),
      );
      outcomes.validPayload = await settle(() =>
        executeInSandbox(async () => ({ doubled: 42 }), {}, { maxPayloadSize: 1024 }),
      );
      outcomes.oversized = await settle(() =>
        executeInSandbox(async () => ({ blob: 'x'.repeat(4096) }), {}, { maxPayloadSize: 100 }),
      );
      parentPort.postMessage(outcomes);
    })().catch(err => parentPort.postMessage({ fatal: err.message }));
  `;

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { moduleUrl: securityModuleUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

describe('sandbox execution with undefined handler results (#767)', () => {
  test('worker mode: a handler returning undefined succeeds', async () => {
    const result = await executeInSandbox(() => undefined, {});
    assert.equal(result, undefined);
  });

  test('worker mode: a Promise resolving to undefined succeeds', async () => {
    const result = await executeInSandbox(async () => undefined, {});
    assert.equal(result, undefined);
  });

  test('worker mode: valid results are still returned', async () => {
    const result = await executeInSandbox(async params => ({ doubled: params.value * 2 }), {
      value: 21,
    });
    assert.deepEqual(result, { doubled: 42 });
  });

  test('worker mode: oversized serialized results are still rejected', async () => {
    await assert.rejects(
      executeInSandbox(async () => ({ data: 'x'.repeat(2_000_000) }), {}, { maxPayloadSize: 1000 }),
      /exceeds maximum size|payload_too_large/,
    );
  });

  test('worker mode: a valid result just under the limit is accepted', async () => {
    const result = await executeInSandbox(
      async () => ({ data: 'x'.repeat(100) }),
      {},
      {
        maxPayloadSize: 1000,
      },
    );
    assert.equal(result.data.length, 100);
  });

  test('direct mode: undefined, promises and payload limits behave the same', async () => {
    const outcomes = await runDirectScenarios();

    assert.equal(outcomes.fatal, undefined, `worker failed: ${outcomes.fatal}`);

    assert.equal(outcomes.undefinedSync.ok, true);
    assert.equal(outcomes.undefinedSync.value, undefined);

    assert.equal(outcomes.undefinedAsync.ok, true);
    assert.equal(outcomes.undefinedAsync.value, undefined);

    assert.equal(outcomes.validPayload.ok, true);
    assert.deepEqual(outcomes.validPayload.value, { doubled: 42 });

    assert.equal(outcomes.oversized.ok, false);
    assert.match(outcomes.oversized.message, /payload_too_large/);
  });
});
