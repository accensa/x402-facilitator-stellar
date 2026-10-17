import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  StandaloneProjectionWorker,
  processToCaughtUp,
  simulateRecoveryTest,
  verifyCheckpointPersistence,
} from '../src/eventstore/projection-worker.js';
import { ProjectionWorker } from '../src/settlement-cqrs.js';

const silentLog = { info() {}, debug() {}, warn() {}, error() {} };
const silentMetrics = {
  observeProjectionBatchDuration() {},
  incProjectionEventsProcessed() {},
  setProjectionThroughput() {},
  setProjectionLag() {},
};

function captureShutdownEnvironment() {
  const originalOn = process.on;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const handlers = [];
  const exits = [];
  const logs = [];
  const errors = [];

  process.on = (signal, handler) => {
    handlers.push({ signal, handler });
    return process;
  };
  process.exit = code => exits.push(code);
  console.log = (...args) => logs.push(args);
  console.error = (...args) => errors.push(args);

  return {
    handlers,
    exits,
    logs,
    errors,
    restore() {
      process.on = originalOn;
      process.exit = originalExit;
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function createCheckpointPool(offsets) {
  let persistedOffset = offsets[0] ?? 0;
  let reads = 0;

  return {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement.startsWith('CREATE TABLE') || statement.startsWith('CREATE INDEX')) {
        return { rows: [] };
      }
      if (statement.startsWith('INSERT INTO settlement_projection_checkpoint')) {
        return { rows: [] };
      }
      if (statement.startsWith('SELECT last_seq')) {
        persistedOffset = offsets[reads] ?? persistedOffset;
        reads++;
        return { rows: [{ last_seq: persistedOffset }] };
      }
      if (statement.startsWith('UPDATE settlement_projection_checkpoint')) {
        persistedOffset = params[0];
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
  };
}

describe('Standalone projection worker shutdown', () => {
  test('stop awaits the inner worker before ending the pool', async () => {
    const order = [];
    const standalone = new StandaloneProjectionWorker(
      {},
      {
        async end() {
          order.push('pool');
        },
      },
    );
    standalone.worker = {
      async stop() {
        order.push('worker');
      },
    };

    await standalone.stop();

    assert.deepEqual(order, ['worker', 'pool']);
  });

  test('stop ends the pool when the worker was never started', async () => {
    let poolEnds = 0;
    const standalone = new StandaloneProjectionWorker(
      {},
      {
        async end() {
          poolEnds++;
        },
      },
    );

    await assert.doesNotReject(() => standalone.stop());
    assert.equal(poolEnds, 1);
  });

  test('SIGTERM and SIGINT share one shutdown and drain the pool once', async () => {
    const environment = captureShutdownEnvironment();
    try {
      let releaseStop;
      let markStopStarted;
      const stopStarted = new Promise(resolve => {
        markStopStarted = resolve;
      });
      let stopCalls = 0;
      let poolEnds = 0;
      const standalone = new StandaloneProjectionWorker(
        {},
        {
          async end() {
            poolEnds++;
          },
        },
      );
      standalone.worker = {
        stop: async () => {
          stopCalls++;
          markStopStarted();
          await new Promise(resolve => {
            releaseStop = resolve;
          });
        },
      };
      standalone.setupShutdownHandlers();

      assert.deepEqual(
        environment.handlers.map(({ signal }) => signal),
        ['SIGTERM', 'SIGINT'],
      );
      const firstSignal = environment.handlers[0].handler();
      await stopStarted;
      const secondSignal = environment.handlers[1].handler();
      releaseStop();
      await Promise.all([firstSignal, secondSignal]);

      assert.equal(stopCalls, 1);
      assert.equal(poolEnds, 1);
      assert.deepEqual(environment.exits, [0]);
    } finally {
      environment.restore();
    }
  });

  test('a rejected shutdown logs the error and exits non-zero', async () => {
    const environment = captureShutdownEnvironment();
    try {
      const failure = new Error('worker stop failed');
      const standalone = new StandaloneProjectionWorker({}, { async end() {} });
      standalone.worker = {
        async stop() {
          throw failure;
        },
      };
      standalone.setupShutdownHandlers();

      await environment.handlers[0].handler();

      assert.deepEqual(environment.exits, [1]);
      assert.equal(environment.errors[0][0], 'Error during shutdown:');
      assert.strictEqual(environment.errors[0][1], failure);
    } finally {
      environment.restore();
    }
  });
});

describe('Standalone projection worker operator helpers', () => {
  test('processToCaughtUp reports success after reaching the stream head', async () => {
    let offset = 0;
    const worker = {
      checkpoint: { getOffset: () => offset },
      reader: {
        async getMaxSequence() {
          return 2;
        },
      },
      async processBatch() {
        offset++;
      },
    };

    assert.deepEqual(await processToCaughtUp(worker), {
      caughtUp: true,
      iterations: 1,
      offset: 2,
    });
  });

  test('processToCaughtUp reports failure when processing makes no progress', async () => {
    const worker = {
      checkpoint: { getOffset: () => 2 },
      reader: {
        async getMaxSequence() {
          return 5;
        },
      },
      async processBatch() {},
    };

    assert.deepEqual(await processToCaughtUp(worker), {
      caughtUp: false,
      iterations: 1,
      offset: 2,
      remainingLag: 3,
    });
  });

  test('simulateRecoveryTest reports recovered and mismatched checkpoints', async () => {
    for (const [offsets, recovered] of [
      [[7, 7], true],
      [[7, 8], false],
    ]) {
      const pool = createCheckpointPool(offsets);
      const worker = new ProjectionWorker(pool, silentMetrics, { log: silentLog });
      await worker.initialize();

      assert.deepEqual(await simulateRecoveryTest(worker), {
        beforeCrash: 7,
        afterRestart: offsets[1],
        recovered,
      });
    }
  });

  test('verifyCheckpointPersistence returns both matching and mismatched verdicts', async () => {
    for (const [storedOffset, persisted] of [
      [12, true],
      [11, false],
    ]) {
      const row = { last_seq: storedOffset, last_processed_at: '2026-10-17T00:00:00Z' };
      const result = await verifyCheckpointPersistence(
        {
          async query() {
            return { rows: [row] };
          },
        },
        12,
      );

      assert.deepEqual(result, { persisted, checkpoint: row });
    }
  });
});
