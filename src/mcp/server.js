import { createInterface } from 'readline';

/**
 * Minimal MCP Stdio Server.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout, as the MCP stdio
 * transport requires. Three transport-level invariants shape this file:
 *
 *  1. Responses are never interleaved (#197): requests are processed one line
 *     at a time and every write goes through a queue that honours write()'s
 *     `false` return by parking on 'drain'. On a pipe — which stdout always is
 *     here — an unchecked write can sit in Node's buffer while the next
 *     response is appended behind it; two JSON objects sharing a line is not a
 *     parseable message, it is a dead connection.
 *  2. A notification — a request with no `id` — is never answered (#198), not
 *     with a result and not with an error; the send helpers refuse to emit a
 *     frame without an id, because JSON.stringify would silently drop the
 *     undefined key and put a malformed message on the wire.
 *  3. A malformed or unsupported frame is answered, never ignored (#199): a
 *     batch (a JSON array) is rejected with -32600 — the MCP protocol does not
 *     support JSON-RPC batching — and anything that is not an object with a
 *     string `method` gets -32600 rather than the silence a client times out on.
 */
export class McpServer {
  constructor({ name, version, logger = console } = {}) {
    this.name = name;
    this.version = version;
    this.logger = logger;
    this.tools = new Map();
    // Stdio wiring, filled in by start(); overridable for tests.
    this._stdout = null;
    this._rl = null;
    this._open = false;
    this._drain = null; // tail of the write queue
    this._releasers = new Set(); // parked release hooks of the in-flight write
  }

  tool(name, schema, handler) {
    this.tools.set(name, { schema, handler });
  }

  /**
   * Reads requests from `stdin`, writes responses to `stdout`. Defaults to
   * the process stdio; tests inject streams.
   */
  async start({ stdin = process.stdin, stdout = process.stdout } = {}) {
    this._stdout = stdout;
    this._open = true;

    // #197: a client that disconnects mid-write makes stdout emit an 'error'
    // event (EPIPE). Without a listener Node raises it as an unhandled error
    // and the process dies mid-response with a stack trace; with one, the
    // server stops cleanly. Any other write error is rethrown — not ours to swallow.
    if (typeof stdout.on === 'function') {
      stdout.on('error', err => {
        if (err && err.code === 'EPIPE') {
          this.logger.error?.('mcp: stdout closed (EPIPE) — client disconnected, stopping');
          this._open = false;
          this._releaseAll();
          this._rl?.close();
        } else {
          throw err;
        }
      });
    }

    const rl = createInterface({ input: stdin, terminal: false });
    this._rl = rl;

    // #197: one request in flight at a time. 'line' fires faster than async
    // handlers finish; processing them concurrently would let a small response
    // overtake a large one on a backpressured pipe. Serializing keeps response
    // order equal to request order — the simplest ordering a client can rely on.
    let tail = Promise.resolve();
    rl.on('line', line => {
      if (!line.trim()) return;
      tail = tail
        .then(() => this._processLine(line))
        .catch(err =>
          this.logger.error?.(`mcp: unhandled dispatch failure: ${err?.message ?? err}`),
        );
    });
    // stdin ended — the client is going away. Stop accepting work; responses
    // already handed to _write keep the event loop alive until the stream
    // drains (or the process is explicitly exited, e.g. on a signal).
    rl.on('close', () => {
      this._open = false;
    });
  }

  /**
   * Resolves once every queued response has been handed to the stream and, if
   * the stream is backpressured, drained. Tests and graceful shutdown await
   * this instead of sleeping a hardcoded interval.
   */
  async flush() {
    await (this._drain ?? Promise.resolve()).catch(() => {});
  }

  /** Stop reading. Queued writes are abandoned; call flush() beforehand. */
  close() {
    this._open = false;
    this._releaseAll();
    this._rl?.close();
  }

  async _processLine(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      // id is null here per JSON-RPC: the request's id could not be detected.
      this._sendError(null, -32700, 'Parse error');
      return;
    }

    // #199: a batch is an array of requests, answered with an array. The MCP
    // protocol does not support JSON-RPC batching, so the shape is rejected
    // explicitly — dispatching it as a single request produced silence, and
    // silence is the one behaviour a client cannot recover from.
    if (Array.isArray(req)) {
      if (req.length === 0) {
        this._sendError(null, -32600, 'Invalid Request: batch must not be empty');
      } else {
        this._sendError(null, -32600, 'Invalid Request: JSON-RPC batch requests are not supported');
      }
      return;
    }

    // #199: anything that is not an object with a string method is an invalid
    // request and must be answered. The id is echoed when detectable, null per
    // JSON-RPC when it is not.
    if (typeof req !== 'object' || req === null || typeof req.method !== 'string') {
      const id = typeof req === 'object' && req !== null && req.id !== undefined ? req.id : null;
      this._sendError(id, -32600, 'Invalid Request');
      return;
    }

    try {
      await this._handleRequest(req);
    } catch (err) {
      // #198: a notification is never answered, even on failure — JSON-RPC
      // forbids responding to a request without an id, and a frame with a
      // missing id key is what a strict client reads as malformed. Log it.
      if (req.id !== undefined) {
        this._sendError(req.id, -32603, 'Internal error', err.message);
      } else {
        this.logger.error?.(`mcp: notification ${req.method} failed: ${err.message}`);
      }
    }
  }

  async _handleRequest(req) {
    if (req.method === 'initialize') {
      this._sendResult(req.id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: this.name, version: this.version },
        capabilities: { tools: {} },
      });
    } else if (req.method === 'tools/list') {
      const tools = Array.from(this.tools.entries()).map(([name, { schema }]) => ({
        name,
        description: schema.description || '',
        inputSchema: {
          type: 'object',
          properties: schema.properties || {},
          required: schema.required || [],
        },
      }));
      this._sendResult(req.id, { tools });
    } else if (req.method === 'tools/call') {
      const toolName = req.params?.name;
      const toolArgs = req.params?.arguments || {};
      const tool = this.tools.get(toolName);

      if (!tool) {
        // tools/call exists and was dispatched correctly — what is invalid is
        // the *parameter* (the tool name). Per the MCP spec's error handling,
        // an unknown tool is a protocol error with the invalid-params code
        // -32602 and a message that names the tool, not -32601 (method not
        // found), so a client can tell "this server has no such tool" from
        // "this server does not speak tools/call" and re-read tools/list.
        // The list of valid names rides in error.data so a confused client can
        // self-correct without a second round trip.
        this._sendError(req.id, -32602, `Unknown tool: ${toolName ?? '(missing name)'}`, {
          validTools: Array.from(this.tools.keys()),
        });
        return;
      }

      try {
        const result = await tool.handler(toolArgs);
        this._sendResult(req.id, {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
          isError: false,
        });
      } catch (err) {
        // A tool's own execution failure (an API failure, invalid input data, a
        // business-logic error) is reported inside the tool result with
        // isError: true, per the spec — protocol errors are reserved for
        // protocol problems (see the unknown-tool branch above). An internal
        // failure that is not a deliberate tool error remains a -32603 server
        // error.
        if (err && err.isToolError) {
          this._sendResult(req.id, {
            content: [{ type: 'text', text: JSON.stringify(err.payload || err.message, null, 2) }],
            isError: true,
          });
        } else {
          this._sendError(req.id, -32603, err && err.message ? err.message : String(err));
        }
      }
    } else if (req.method === 'ping') {
      this._sendResult(req.id, {});
    } else if (req.method === 'notifications/initialized') {
      // no response needed
    } else {
      // A genuinely unknown METHOD is a protocol problem, so it keeps the
      // -32601 (method not found) code — distinct from an unknown tool, which
      // is invalid params.
      if (req.id !== undefined) {
        this._sendError(req.id, -32601, 'Method not found');
      }
    }
  }

  _sendResult(id, result) {
    // #198: a result frame without an id answers a notification. JSON-RPC
    // forbids that, and JSON.stringify would drop the undefined key and emit
    // a message a strict client must treat as malformed — refuse instead.
    if (id === undefined) {
      this.logger.error?.('mcp: refusing to send a result with no id (request was a notification)');
      return;
    }
    this._write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  _sendError(id, code, message, data) {
    if (id === undefined) {
      // #198: same rule as _sendResult. (id === null is fine — JSON-RPC uses
      // it for parse errors and invalid requests whose id was undetectable.)
      this.logger.error?.(
        `mcp: refusing to send error ${code} for a request with no id: ${message}`,
      );
      return;
    }
    const error = { code, message };
    if (data !== undefined) error.data = data;
    this._write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
  }

  /**
   * #197: the single writer. Exactly one write is in flight at a time; when
   * the stream buffers (write() returns false) the queue parks on 'drain'
   * before the next write is issued. This is what keeps a large response and
   * the small response behind it from being interleaved inside Node's pipe
   * buffer, and what bounds the memory a slow reader can make us allocate.
   */
  _write(chunk) {
    const attempt = () =>
      new Promise(resolve => {
        if (!this._open) return resolve();
        const ok = this._stdout.write(chunk);
        if (ok) return resolve();
        const release = () => {
          this._stdout.off?.('drain', release);
          this._stdout.off?.('error', release);
          this._releasers.delete(release);
          resolve();
        };
        this._releasers.add(release);
        this._stdout.once('drain', release);
        // An EPIPE while parked must not deadlock everything queued behind it.
        this._stdout.on?.('error', release);
      });
    const next = this._drain ? this._drain.then(attempt, attempt) : attempt();
    this._drain = next;
    return next;
  }

  _releaseAll() {
    for (const release of [...this._releasers]) release();
  }
}
