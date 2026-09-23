/**
 * Process-level error handlers (#205).
 *
 * Node's default behaviour for an unhandled promise rejection (or an
 * `uncaughtException`) is to terminate — but on this service that happened
 * without any application log line, because nothing listened. A boot-time
 * `EADDRINUSE`, a rejected promise in a fire-and-forget path, or an exception
 * thrown outside a request left an operator staring at a process that simply
 * vanished. The issue is not that the process exits; it is that it exits
 * silently.
 *
 * These handlers make the failure legible and give the process a deliberate,
 * non-zero exit:
 *
 *   - the error and its stack are written through the injected logger, so it
 *     lands in the same stream as the rest of the service's diagnostics;
 *   - a second event during handling is ignored, so a handler that itself trips
 *     another event cannot recurse or print twice;
 *   - the exit code is non-zero, which is what a supervisor, a health-check
 *     sidecar or CI keys on to tell "crashed" from "shut down cleanly".
 *
 * Deliberately no async work here: an `uncaughtException` handler must not
 * await. A graceful drain belongs to the SIGTERM/SIGINT path in server.js; by
 * the time an uncaught exception reaches us the process state is not safe to
 * keep serving on.
 */

/**
 * Builds the handler pair without attaching it, so the behaviour is testable
 * with an injected logger and exit function.
 *
 * @param {object} [options]
 * @param {(message: string) => void} [options.log] - receives the diagnostic line
 * @param {(code: number) => void} [options.exit] - terminates the process
 * @returns {{ onUnhandledRejection: (reason: unknown) => void, onUncaughtException: (err: Error) => void }}
 */
export function createProcessErrorHandlers({
  log = message => console.error(message),
  exit = code => process.exit(code),
} = {}) {
  let handling = false;

  function fatal(label, error) {
    if (handling) return;
    handling = true;
    const detail = error && error.stack ? error.stack : String(error);
    log(`[Fatal] ${label}: ${detail}`);
    exit(1);
  }

  return {
    onUnhandledRejection: reason => fatal('Unhandled promise rejection', reason),
    onUncaughtException: err => fatal('Uncaught exception', err),
  };
}

/**
 * Installs the handlers on `target` (the real `process` in server.js, a fake
 * EventEmitter in tests).
 *
 * @param {NodeJS.Process|import('node:events').EventEmitter} target
 * @param {object} [options]
 * @param {(message: string) => void} [options.log]
 * @param {(code: number) => void} [options.exit]
 * @returns {{ onUnhandledRejection: Function, onUncaughtException: Function }}
 */
export function installProcessErrorHandlers(target, { log, exit } = {}) {
  const handlers = createProcessErrorHandlers({ log, exit });
  target.on('unhandledRejection', handlers.onUnhandledRejection);
  target.on('uncaughtException', handlers.onUncaughtException);
  return handlers;
}
