import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * JSON-RPC 2.0 batch processing for the MCP server (#428).
 *
 * A batch is an array of requests answered with an array of responses. Each
 * member is dispatched independently and concurrently (Promise.allSettled), so
 * one failing call never affects its neighbours, and every response carries the
 * id of the request it answers. Per spec, notifications (no `id`) produce no
 * response, and a batch made only of notifications produces no output at all.
 *
 * The server's send helpers write to the wire; inside a batch member they must
 * instead hand their frame back to the batch. That redirection is an
 * AsyncLocalStorage sink, which keeps concurrent members from mixing frames.
 */

/** Largest batch accepted; bigger ones are refused whole to bound work per frame. */
export const MAX_BATCH_SIZE = 25;

const sinks = new AsyncLocalStorage();

/** The active batch member's frame collector, or undefined outside a batch. */
export function currentBatchSink() {
  return sinks.getStore();
}

const errorFrame = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * Runs a batch and returns what to put on the wire: a single error frame for a
 * batch that is refused as a whole (empty or oversized), otherwise the array of
 * member responses in request order (possibly empty).
 *
 * @param {unknown[]} batch - the parsed JSON array
 * @param {(req: object) => Promise<void>} dispatch - handles one request,
 *   emitting its response through the server's send helpers
 * @param {{maxSize?: number}} [options]
 * @returns {Promise<object | object[]>}
 */
export async function processBatch(batch, dispatch, { maxSize = MAX_BATCH_SIZE } = {}) {
  if (batch.length === 0) {
    return errorFrame(null, -32600, 'Invalid Request: batch must not be empty');
  }
  if (batch.length > maxSize) {
    return errorFrame(
      null,
      -32600,
      `Invalid Request: batch of ${batch.length} exceeds the maximum of ${maxSize} requests`,
    );
  }

  const settled = await Promise.allSettled(
    batch.map(async req => {
      if (typeof req !== 'object' || req === null || typeof req.method !== 'string') {
        const id = typeof req === 'object' && req !== null && req.id !== undefined ? req.id : null;
        return [errorFrame(id, -32600, 'Invalid Request')];
      }
      const frames = [];
      try {
        await sinks.run(frames, () => dispatch(req));
      } catch (err) {
        // A notification is never answered, even on failure.
        if (req.id !== undefined) {
          const frame = errorFrame(req.id, -32603, 'Internal error');
          frame.error.data = err?.message ?? String(err);
          frames.push(frame);
        }
      }
      return frames;
    }),
  );

  // Members never reject (each catches its own failure), but a rejected slot
  // must not take the batch down with it: drop it rather than throw.
  return settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
}
