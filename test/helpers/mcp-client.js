/**
 * Test-only MCP stdio client, plus the framing and capture primitives it is
 * built from.
 *
 * Extracted from test/mcp.test.js (#386) so the client's state machine can be
 * unit-tested directly — with an injected `spawn`, so no subprocess and no
 * timing luck is involved — while the integration tests keep driving the real
 * `src/mcp/cli.js` over a real pipe.
 *
 * Three pieces, each with one job:
 *
 * - {@link LineFramer} turns a stream of arbitrary chunks into whole lines.
 *   Rewritten for #388: the previous `buffer += chunk; buffer.split('\n')` loop
 *   re-split the entire undelivered tail on every chunk and allocated one line
 *   array per chunk, so a large response arriving in many small reads cost
 *   O(message size x chunk count). The framer scans each chunk once and joins
 *   the pieces of a line only when that line actually ends.
 * - {@link BoundedCapture} keeps the first `maxBytes` of a child's stderr.
 *   Previously every stderr chunk was retained for the life of the process and
 *   re-concatenated on each error path, so a chatty child both grew without
 *   bound and made every failure more expensive than the last.
 * - {@link createMcpClient} owns requests, timeouts and teardown.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The MCP CLI under test, resolved relative to this helper. */
export const MCP_CLI_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/mcp/cli.js',
);

/**
 * Every error code {@link createMcpClient} can raise.
 *
 * The list is the coverage guard for this suite (#386): test/mcp.test.js drives
 * each code at least once and then asserts that the set it produced equals this
 * list, so adding a code — or deleting the test that produces one — fails the
 * run rather than quietly shrinking what "the client's error handling" means.
 */
export const MCP_CLIENT_ERROR_CODES = Object.freeze([
  'SPAWN_FAILED',
  'PROCESS_ERROR',
  'PROCESS_EXIT',
  'PARSE_ERROR',
  'TOOL_CALL_FAILED',
  'TIMEOUT',
  'STDIN_WRITE_ERROR',
  'STDIN_WRITE_EXCEPTION',
  'CLIENT_CLOSED',
  'KILL_ERROR',
]);

/**
 * An MCP client failure with a stable `code` and the context needed to debug
 * it. `context` is always present (possibly empty) so callers never have to
 * null-check it before logging.
 */
export class McpClientError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'McpClientError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Incremental newline-delimited framer (#388).
 *
 * Feed it whatever the stream hands over; it calls `onLine` once per complete
 * line, in order, and skips whitespace-only lines — the same contract the
 * `buffer += chunk; split('\n')` loop had, without the quadratic rescan.
 *
 * The undelivered tail is kept as a list of slices and only joined when the
 * line it belongs to is complete, so a 1 MB response that arrives in 4 KB reads
 * is copied once instead of once per read.
 */
export class LineFramer {
  constructor(onLine) {
    this.onLine = onLine;
    this.parts = [];
  }

  /**
   * Frames one chunk. Accepts a Buffer or a string.
   *
   * @param {Buffer|string} chunk - The next piece of the stream.
   */
  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    let start = 0;

    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      const tail = text.slice(start, nl);
      let line;
      if (this.parts.length === 0) {
        line = tail;
      } else {
        this.parts.push(tail);
        line = this.parts.join('');
        // Reset before the callback: a throwing consumer must not leave half a
        // line in the buffer behind it.
        this.parts.length = 0;
      }
      start = nl + 1;
      if (line.trim()) this.onLine(line);
    }

    if (start < text.length) this.parts.push(text.slice(start));
  }

  /** The bytes received but not yet terminated by a newline, as text. */
  get pending() {
    return this.parts.length === 0 ? '' : this.parts.join('');
  }
}

/**
 * A bounded sink for a child's stderr (#388).
 *
 * Retains at most `maxBytes` (the head: a crash prints its cause before it
 * prints its noise) and counts the rest without copying it, so memory and the
 * cost of rendering a diagnostic are both independent of how much the child
 * managed to log. `text()` is memoised because every error path renders it.
 */
export class BoundedCapture {
  constructor(maxBytes = 64 * 1024) {
    this.maxBytes = maxBytes;
    this.parts = [];
    this.bytes = 0;
    this.droppedBytes = 0;
    this.cached = null;
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.cached = null;
    if (this.bytes >= this.maxBytes) {
      this.droppedBytes += buffer.length;
      return;
    }
    const room = this.maxBytes - this.bytes;
    if (buffer.length <= room) {
      this.parts.push(buffer);
      this.bytes += buffer.length;
      return;
    }
    // Copy only what fits: keeping a subarray would pin the whole chunk.
    this.parts.push(Buffer.from(buffer.subarray(0, room)));
    this.bytes += room;
    this.droppedBytes += buffer.length - room;
  }

  /** Bytes actually retained, never more than `maxBytes`. */
  get retainedBytes() {
    return this.bytes;
  }

  get truncated() {
    return this.droppedBytes > 0;
  }

  text() {
    if (this.cached === null) this.cached = Buffer.concat(this.parts).toString();
    return this.cached;
  }
}

/**
 * Spawns the MCP CLI and speaks JSON-RPC over stdio.
 *
 * @param {object} env - Extra environment for the child (merged over process.env).
 * @param {object} [options] - Test seams and tunables.
 * @param {number} [options.timeout=30000] - Per-call timeout in ms.
 * @param {number} [options.killGraceMs=5000] - SIGTERM -> SIGKILL grace period.
 * @param {string} [options.cliPath] - Script to spawn (defaults to the real CLI).
 * @param {number} [options.maxStderrBytes] - Stderr retained for diagnostics.
 * @param {boolean} [options.echoStderr=true] - Mirror child stderr to ours.
 * @param {Function} [options.spawn] - Spawn implementation; inject a fake to
 *   unit-test the client without a subprocess.
 * @param {Function} [options.onError] - Observer for async client errors.
 * @returns {{callTool: Function, close: Function, isClosed: Function,
 *   stderr: Function, stderrCapture: BoundedCapture}}
 */
export function createMcpClient(env, options = {}) {
  const {
    timeout = 30000,
    killGraceMs = 5000,
    cliPath = MCP_CLI_PATH,
    maxStderrBytes = 64 * 1024,
    echoStderr = true,
    spawn = nodeSpawn,
    onError = err => console.error('MCP client error:', err),
  } = options;

  // The test runner marks the files it collects with NODE_TEST_CONTEXT. The
  // child here is a peer process, not a collected test file, so the marker is
  // stripped — otherwise the scripted fixture would mistake it for a file the
  // runner is collecting and exit instead of answering (#470).
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;

  let child;
  try {
    child = spawn(process.execPath, [cliPath], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new McpClientError('Failed to spawn MCP CLI process', 'SPAWN_FAILED', {
      cliPath,
      originalError: err.message,
    });
  }

  const stderrCapture = new BoundedCapture(maxStderrBytes);
  child.stderr.on('data', chunk => {
    stderrCapture.push(chunk);
    if (echoStderr) process.stderr.write(chunk);
  });

  let messageId = 1;
  const pending = new Map();
  let closed = false;
  let killTimer = null;

  /** Rejects everything in flight with one error, and empties the map. */
  const failPending = error => {
    for (const { reject, timeoutId } of pending.values()) {
      clearTimeout(timeoutId);
      reject(error);
    }
    pending.clear();
  };

  const framer = new LineFramer(line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (parseError) {
      onError(
        new McpClientError('Failed to parse MCP response', 'PARSE_ERROR', {
          line,
          parseError: parseError.message,
        }),
      );
      return;
    }

    if (msg.id === undefined || !pending.has(msg.id)) return;

    const { resolve, reject, timeoutId } = pending.get(msg.id);
    clearTimeout(timeoutId);
    pending.delete(msg.id);

    if (msg.error) {
      reject(
        new McpClientError(msg.error.message || 'MCP tool call failed', 'TOOL_CALL_FAILED', {
          errorCode: msg.error.code,
          errorData: msg.error.data,
        }),
      );
    } else {
      resolve(msg.result);
    }
  });

  child.stdout.on('data', chunk => framer.push(chunk));

  child.on('error', err => {
    const error = new McpClientError('MCP child process error', 'PROCESS_ERROR', {
      originalError: err.message,
      stderr: stderrCapture.text(),
    });
    failPending(error);
    onError(error);
  });

  child.on('exit', (code, signal) => {
    // A child that has exited cannot honour the force-kill timer, and leaving
    // it referenced keeps the event loop alive for the whole grace period.
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (closed || pending.size === 0) return;
    failPending(
      new McpClientError('MCP child process exited unexpectedly', 'PROCESS_EXIT', {
        exitCode: code,
        signal,
        stderr: stderrCapture.text(),
      }),
    );
  });

  return {
    /**
     * Calls an MCP tool and resolves with its result.
     *
     * @param {string} name - Tool name.
     * @param {object} args - Tool arguments.
     * @throws {McpClientError} TIMEOUT, PROCESS_ERROR, PROCESS_EXIT,
     *   STDIN_WRITE_ERROR, STDIN_WRITE_EXCEPTION, TOOL_CALL_FAILED or
     *   CLIENT_CLOSED.
     */
    callTool: (name, args) => {
      if (closed) {
        return Promise.reject(
          new McpClientError('Cannot call tool on closed MCP client', 'CLIENT_CLOSED'),
        );
      }

      return new Promise((resolve, reject) => {
        const id = messageId++;

        const timeoutId = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(
              new McpClientError('MCP tool call timed out', 'TIMEOUT', {
                toolName: name,
                timeoutMs: timeout,
              }),
            );
          }
        }, timeout);

        pending.set(id, { resolve, reject, timeoutId });

        const req = JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        });

        try {
          child.stdin.write(req + '\n', err => {
            if (err) {
              clearTimeout(timeoutId);
              pending.delete(id);
              reject(
                new McpClientError('Failed to write to MCP stdin', 'STDIN_WRITE_ERROR', {
                  originalError: err.message,
                }),
              );
            }
          });
        } catch (err) {
          clearTimeout(timeoutId);
          pending.delete(id);
          reject(
            new McpClientError('Exception writing to MCP stdin', 'STDIN_WRITE_EXCEPTION', {
              originalError: err.message,
            }),
          );
        }
      });
    },

    /**
     * Closes the client: every in-flight request is rejected with CLIENT_CLOSED
     * and the child is asked to exit. The SIGKILL escalation timer is unref'd
     * (#388) so a closed client never holds the process open for the grace
     * period — which is most of this suite's runtime when it does.
     */
    close: () => {
      if (closed) return;
      closed = true;

      failPending(new McpClientError('MCP client was closed', 'CLIENT_CLOSED'));

      try {
        child.kill('SIGTERM');

        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, killGraceMs);
        killTimer.unref?.();
      } catch (err) {
        onError(
          new McpClientError('Error killing MCP child process', 'KILL_ERROR', {
            originalError: err.message,
          }),
        );
      }
    },

    isClosed: () => closed,

    /** The child's stderr as retained for diagnostics. */
    stderr: () => stderrCapture.text(),
    stderrCapture,
  };
}
