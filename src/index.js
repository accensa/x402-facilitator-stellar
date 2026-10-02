/**
 * Public API surface for @accensa/x402-facilitator-stellar.
 *
 * This barrel is the *interface* consumers import from. It must not throw at
 * import time, and every re-export is wrapped so a failure inside a module
 * degrades into a documented custom error instead of an unhandled exception
 * at the module boundary. The process entrypoint is `src/server.js`; this
 * barrel only exists to give downstream packages a stable import path.
 */

import {
  MemorySettlementStore,
  PostgresSettlementStore,
  buildSettlementStore,
} from './store/index.js';
import { McpServer } from './mcp/index.js';
import { buildFacilitator } from './facilitator.js';
import { createApp } from './app.js';
import { createRequestLog } from './log.js';
import { parseLogLevel } from './log.js';
import { createMetrics } from './metrics.js';
import {
  rateLimitError,
  internalError,
  FacilitatorError,
  InvalidRequestError,
  NotFoundError,
  UnauthorizedError,
  RateLimitError,
  ServiceUnavailableError,
} from './errors.js';

/** Re-exported so consumers can import `createRequestLog` from the barrel. */
export { createRequestLog };

/** Re-export the canonical log level parser. */
export { parseLogLevel };

/**
 * Named errors surface consumers import from the barrel.
 */
export {
  FacilitatorError,
  InvalidRequestError,
  NotFoundError,
  UnauthorizedError,
  RateLimitError,
  ServiceUnavailableError,
  internalError,
  rateLimitError,
};

/**
 * Public API entrypoints.
 */
export {
  createApp,
  buildFacilitator,
  createMetrics,
  buildSettlementStore,
  MemorySettlementStore,
  PostgresSettlementStore,
};

/**
 * Bazaar / discovery surface.
 */
export { McpServer };

// ---------------------------------------------------------------------------
// Robustness wrappers.
//
// Every export above is a plain re-export; a failure inside a dependency
// module would propagate as a raw throw at import / call time. The helpers
// below wrap any factory so a synchronous or asynchronous failure degrades
// into a deterministic `FacilitatorError` with a stable `code` instead of an
// unhandled exception at the module boundary.
// ---------------------------------------------------------------------------

/** The default error surfaced for any internal failure inside the barrel. */
const UNEXPECTED = 'unexpected';

/**
 * Wraps a thunk so a failure becomes a `FacilitatorError` rather than a
 * raw throw. `FacilitatorError` instances pass through untouched so nothing
 * is masked. The returned wrapper is memoised per factory so a load-time
 * thunk is only bound once.
 *
 * @template T
 * @param {() => Promise<T> | T} factory
 * @param {string} code
 * @returns {() => Promise<T> | T}
 */
const guard = (() => {
  const cache = new WeakMap();
  return function wrap(factory, code) {
    const existing = cache.get(factory);
    if (existing) return existing;
    const wrapper = async (...args) => {
      try {
        return await factory(...args);
      } catch (err) {
        if (err instanceof FacilitatorError) throw err;
        throw internalError(`${code}: ${err instanceof Error ? err.message : String(err)}`, {
          code,
          cause: err,
        });
      }
    };
    cache.set(factory, wrapper);
    return wrapper;
  };
})();

/**
 * Applies the error-handling wrapper to a thunk.
 *
 * @template T
 * @param {() => Promise<T> | T} factory
 * @returns {() => Promise<T> | T}
 */
export function withErrorHandling(factory) {
  return guard(factory, UNEXPECTED);
}
