/**
 * DLQ retry worker.
 *
 * A message here already exhausted its original delivery budget (see
 * src/webhooks/dispatcher.js and src/outbox/worker.js), so this runs a
 * second, slower, independent backoff schedule against the same receiver —
 * useful for the outage-that-eventually-clears case without operator
 * involvement, while `DLQ_MAX_RETRY_ATTEMPTS` bounds how long it tries before
 * requiring a human (`exhausted`, see the operator API in src/dlq/routes.js).
 *
 * Shaped identically to src/outbox/worker.js on purpose: same claim/publish/
 * mark cycle, same plain-interval runner, so the two are recognisably one
 * pattern applied twice rather than two designs.
 */

/**
 * Attempts one redelivery of a dead-lettered record. Shared by the background
 * poll loop and the operator API's manual "replay now" action so both paths
 * mark state identically.
 *
 * @param {object} options
 * @param {import('./store.js').DeadLetterStore} options.dlq
 * @param {object} row - a row from claimDue()/get(), carrying id and payload
 * @param {(record: object) => Promise<unknown>} options.publish
 * @param {object} [options.retryOptions] - maxDlqAttempts/baseBackoffMs, see markRetryFailed
 * @returns {Promise<{delivered: boolean, error?: string}>}
 */
export async function attemptRedelivery({ dlq, row, publish, retryOptions }) {
  try {
    await publish(row.payload);
    await dlq.markResolved(row.id);
    return { delivered: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await dlq.markRetryFailed(row.id, message, retryOptions);
    return { delivered: false, error: message };
  }
}

/**
 * Runs one poll/retry cycle, then reports the current depth so the caller can
 * drive the alert-threshold check and the metrics gauge off one query.
 *
 * @param {object} options
 * @param {import('./store.js').DeadLetterStore} options.dlq
 * @param {(record: object) => Promise<unknown>} options.publish
 * @param {number} [options.maxDlqAttempts]
 * @param {number} [options.baseBackoffMs]
 * @param {number} [options.batchSize]
 * @param {number} [options.leaseMs]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{claimed: number, resolved: number, failed: number, depth: {pending: number, exhausted: number, resolved: number, discarded: number}}>}
 */
export async function pollDlqOnce({
  dlq,
  publish,
  maxDlqAttempts = 5,
  baseBackoffMs = 30_000,
  batchSize = 50,
  leaseMs = 60_000,
  log = () => {},
}) {
  let rows;
  try {
    rows = await dlq.claimDue({ limit: batchSize, leaseMs });
  } catch (err) {
    log(`[DLQ] poll failed: ${err.message}`);
    return { claimed: 0, resolved: 0, failed: 0, depth: null };
  }

  let resolved = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await attemptRedelivery({
      dlq,
      row,
      publish,
      retryOptions: { maxDlqAttempts, baseBackoffMs },
    });
    if (result.delivered) {
      resolved++;
    } else {
      failed++;
      log(
        `[DLQ] retry failed for message ${row.message_id} (attempt ${row.dlq_attempts + 1}/${maxDlqAttempts}): ${result.error}`,
      );
    }
  }

  const depth = await dlq.countByStatus().catch(() => null);
  return { claimed: rows.length, resolved, failed, depth };
}

/**
 * Starts the periodic DLQ worker. Also owns the depth-alert check (#DLQ):
 * when `pending + exhausted` crosses `alertThreshold`, `onAlert` fires — at
 * most once per breach (it resets once depth drops back under threshold) so a
 * stuck queue does not spam the sink every poll interval.
 *
 * @param {object} options - same as pollDlqOnce, plus:
 * @param {number} [options.intervalMs]
 * @param {number} [options.alertThreshold] - 0 disables the check
 * @param {(depth: {pending: number, exhausted: number}) => void} [options.onAlert]
 * @param {(gauge: {status: string, value: number}) => void} [options.onDepth] - metrics sink
 */
export function startDlqWorker({
  intervalMs = 10_000,
  alertThreshold = 0,
  onAlert = depth =>
    console.warn(
      `[DLQ] ALERT: depth ${depth.pending + depth.exhausted} exceeds threshold (pending=${depth.pending}, exhausted=${depth.exhausted})`,
    ),
  onDepth = null,
  ...pollOptions
}) {
  let timer = null;
  let running = false;
  let stopped = false;
  let alerting = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const { depth } = await pollDlqOnce(pollOptions);
      if (!depth) return;

      onDepth?.({ status: 'pending', value: depth.pending });
      onDepth?.({ status: 'exhausted', value: depth.exhausted });

      if (alertThreshold > 0) {
        const actionable = depth.pending + depth.exhausted;
        if (actionable > alertThreshold && !alerting) {
          alerting = true;
          onAlert(depth);
        } else if (actionable <= alertThreshold) {
          alerting = false;
        }
      }
    } catch (err) {
      pollOptions.log?.(`[DLQ] loop error: ${err.message}`);
    }
  };

  return {
    start() {
      if (running || stopped) return this;
      running = true;
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
