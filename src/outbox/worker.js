/**
 * Outbox background worker (#123).
 *
 * Polls `outbox_events` for pending rows, publishes each through an injected
 * `publish(record)` function (the webhook dispatcher's Kafka producer or its
 * direct-delivery path), and marks the row published only after the publish
 * succeeded. A failure leaves the row pending (attempts++) for the next cycle
 * — at-least-once delivery with the database as the durability boundary, so a
 * crash at any point cannot lose a notification.
 *
 * Runs as a plain interval; the loop is kept deliberately dumb so it can be
 * embedded in the main process (server.js) or lifted into a separate process
 * later without changing the store contract.
 */

/**
 * Runs one poll/publish cycle.
 *
 * @param {object} options
 * @param {import('./store.js').OutboxStore} options.outbox
 * @param {(record: object) => Promise<unknown>} options.publish - must resolve
 *   only when the message is durably accepted; throw on failure
 * @param {number} [options.maxAttempts] - publish attempts before a row goes `failed`
 * @param {number} [options.batchSize]
 * @param {number} [options.leaseMs] - claim lease before a stuck row is re-claimed
 * @param {(msg: string) => void} [options.log]
 * @param {() => Date} [options.now] - injectable clock
 * @returns {Promise<{claimed: number, published: number, failed: number}>}
 */
export async function pollOutboxOnce({
  outbox,
  publish,
  maxAttempts = 10,
  batchSize = 50,
  leaseMs = 60_000,
  log = () => {},
  now = () => new Date(),
}) {
  let rows;
  try {
    rows = await outbox.claimBatch({ limit: batchSize, leaseMs });
  } catch (err) {
    log(`[Outbox] poll failed: ${err.message}`);
    return { claimed: 0, published: 0, failed: 0 };
  }

  let published = 0;
  let failed = 0;
  for (const row of rows) {
    // The published record matches what the request-path enqueue used to emit
    // (`{ id, ...event, url, publishedAt }`) so receivers see no shape change.
    const record = {
      id: row.event_id,
      ...row.payload,
      publishedAt: now().toISOString(),
    };
    try {
      await publish(record);
      await outbox.markPublished(row.id);
      published++;
    } catch (err) {
      failed++;
      try {
        await outbox.markFailed(row.id, err.message, maxAttempts);
      } catch (markErr) {
        log(`[Outbox] markFailed for event ${row.event_id} failed: ${markErr.message}`);
      }
      log(
        `[Outbox] publish failed for event ${row.event_id} (${maxAttempts - row.attempts} attempts left): ${err.message}`,
      );
    }
  }

  return { claimed: rows.length, published, failed };
}

/**
 * Starts the periodic worker. Returns a handle with start()/stop()/tick().
 *
 * @param {object} options - same as pollOutboxOnce, plus intervalMs
 * @param {number} [options.intervalMs]
 */
export function startOutboxWorker({ intervalMs = 5_000, ...pollOptions }) {
  let timer = null;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await pollOutboxOnce(pollOptions);
    } catch (err) {
      pollOptions.log?.(`[Outbox] loop error: ${err.message}`);
    }
  };

  return {
    start() {
      if (running || stopped) return this;
      running = true;
      // unref so the worker never keeps the process alive on its own.
      timer = globalThis.setInterval(() => void tick(), intervalMs);
      timer.unref?.();
      return this;
    },
    async stop() {
      stopped = true;
      running = false;
      if (timer) globalThis.clearInterval(timer);
      timer = null;
    },
    /** Runs one cycle immediately — also what tests drive. */
    tick,
  };
}
