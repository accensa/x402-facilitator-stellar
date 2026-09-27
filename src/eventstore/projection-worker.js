/**
 * Asynchronous projection worker with automatic recovery from last checkpoint.
 *
 * This worker runs independently from the main HTTP service and continuously
 * processes events from the settlement event store, projecting them into
 * optimized read models for fast queries.
 *
 * Features:
 * - Automatic recovery from last processed checkpoint on restart
 * - Handles out-of-order events within the same settlement
 * - Idempotent projection (duplicate events produce same result)
 * - Graceful shutdown with checkpoint persistence
 * - Prometheus metrics for monitoring projection lag
 */

import { ProjectionWorker } from '../settlement-cqrs.js';

/**
 * Standalone projection worker process.
 * Run separately from the main facilitator for isolation.
 */
export class StandaloneProjectionWorker {
  constructor(config, pool, metrics) {
    this.config = config;
    this.pool = pool;
    this.metrics = metrics;
    this.worker = null;
    this.shutdownPromise = null;
  }

  /**
   * Start the projection worker process.
   */
  async start() {
    const options = {
      log: this.config.log || console,
      batchSize: this.config.projectionBatchSize || 100,
      pollInterval: this.config.projectionPollInterval || 1000,
    };

    this.worker = new ProjectionWorker(this.pool, this.metrics, options);
    await this.worker.initialize();

    // Set up graceful shutdown handlers
    this.setupShutdownHandlers();

    // Start the worker loop
    await this.worker.start();
  }

  /**
   * Stop the projection worker gracefully.
   */
  async stop() {
    if (this.worker) {
      await this.worker.stop();
    }

    if (this.pool) {
      await this.pool.end();
    }
  }

  /**
   * Set up signal handlers for graceful shutdown.
   */
  setupShutdownHandlers() {
    const shutdown = async signal => {
      console.log(`Received ${signal}, shutting down gracefully...`);

      if (this.shutdownPromise) {
        return this.shutdownPromise;
      }

      this.shutdownPromise = this.stop();

      try {
        await this.shutdownPromise;
        console.log('Projection worker shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

/**
 * Recovery simulation for testing.
 * Simulates a crash and verifies recovery from checkpoint.
 */
export async function simulateRecoveryTest(worker) {
  // Get current checkpoint
  const beforeCrash = worker.checkpoint.getOffset();

  // Simulate crash (stop worker without clean shutdown)
  worker.running = false;

  // Simulate restart
  const newWorker = new ProjectionWorker(worker.pool, worker.metrics, {
    log: worker.log,
    batchSize: worker.batchSize,
    pollInterval: worker.pollInterval,
  });

  await newWorker.initialize();
  const afterRestart = newWorker.checkpoint.getOffset();

  // Verify checkpoint was persisted and recovered
  return {
    beforeCrash,
    afterRestart,
    recovered: beforeCrash === afterRestart,
  };
}

/**
 * Test helper: Process events until caught up with event stream.
 * Used in tests to verify projection catches up accurately.
 */
export async function processToCaughtUp(worker, maxIterations = 100) {
  let iterations = 0;
  let lastLag = Infinity;

  while (iterations < maxIterations) {
    await worker.processBatch();

    const currentOffset = worker.checkpoint.getOffset();
    const maxSeq = await worker.reader.getMaxSequence();
    const lag = maxSeq - currentOffset;

    if (lag === 0) {
      return { caughtUp: true, iterations, offset: currentOffset };
    }

    if (lag === lastLag) {
      // No progress, likely an error
      break;
    }

    lastLag = lag;
    iterations++;
  }

  return {
    caughtUp: false,
    iterations,
    offset: worker.checkpoint.getOffset(),
    remainingLag: lastLag,
  };
}

/**
 * Helper to handle duplicate and out-of-order events.
 *
 * The projection system handles these scenarios:
 * 1. Duplicate events: ON CONFLICT clause ensures idempotent writes
 * 2. Out-of-order events within same settlement: Events are fetched
 *    and sorted by seq before projection
 * 3. Out-of-order events across settlements: Each settlement is
 *    projected independently, order doesn't matter
 */
export function validateEventOrdering(events) {
  const bySettlement = new Map();

  for (const event of events) {
    const key = event.idempotency_key;
    if (!bySettlement.has(key)) {
      bySettlement.set(key, []);
    }
    bySettlement.get(key).push(event);
  }

  // Sort events within each settlement by sequence number
  for (const [key, settlementEvents] of bySettlement.entries()) {
    settlementEvents.sort((a, b) => a.seq - b.seq);
    bySettlement.set(key, settlementEvents);
  }

  return bySettlement;
}

/**
 * Checkpoint persistence verification.
 * Ensures checkpoint survives process restart.
 */
export async function verifyCheckpointPersistence(pool, testOffset) {
  const query = `
    SELECT last_seq, last_processed_at 
    FROM settlement_projection_checkpoint 
    WHERE id = 1
  `;

  const result = await pool.query(query);
  const row = result.rows[0];

  return {
    persisted: row.last_seq === testOffset,
    checkpoint: row,
  };
}
