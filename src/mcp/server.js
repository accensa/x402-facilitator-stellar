import { createInterface } from 'readline';
import { getPrompt, listPrompts } from './prompts.js';
import { McpInputError } from './sanitize.js';
import { listResourceTemplates, listResources, readResource } from './resources.js';
import { createServer } from 'node:http';
import { MAX_BATCH_SIZE, currentBatchSink, processBatch } from './batch.js';

/**
 * Protocol revisions this server will negotiate, oldest first (#169).
 *
 * Every one of them is a *handshake-era* revision: the client names a version
 * in `initialize` and the server answers with the revision the connection will
 * use. The tool surface this server implements (`initialize`, `tools/list`,
 * `tools/call`, `ping`) is unchanged across them, so echoing the client's
 * revision is an honest claim rather than an optimistic one. The modern
 * (no-handshake) era is out of scope here: those clients never send
 * `initialize`, and a server for them would be a different transport.
 *
 * Extend this list in one place — the initialize handler reads it, and so do
 * the tests and docs/MCP.md.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

/** Newest handshake-era revision: the counter-offer for anything else. */
export const LATEST_PROTOCOL_VERSION =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

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
 *  3. A malformed frame is answered, never ignored (#199): anything that is not
 *     an object with a string `method` gets -32600 rather than the silence a
 *     client times out on. A JSON array is a JSON-RPC 2.0 batch (#428): members
 *     run concurrently and are answered with an array (see ./batch.js).
 *
 * Beyond `tools/*` the server also speaks the `prompts/*` and `resources/*`
 * halves of MCP (#391). Both follow the same two-tier error contract as tools,
 * so they share `_sendSemanticError` rather than growing their own.
 */
export class McpServer {
  /**
   * @param {object} options
   * @param {string} options.name
   * @param {string} options.version
   * @param {object} [options.logger=console]
   * @param {(path: string, params?: object) => Promise<object>} [options.fetchDiscovery]
   *   facilitator HTTP helper, required to serve `resources/read` (#391). The
   *   semantic resources are URIs into the catalog, so without a way to reach
   *   the catalog they are advertised but not readable — the capability is
   *   omitted from `initialize` in that case rather than advertised and failing
   *   on first use.
   * @param {boolean} [options.prompts=true] - serve `prompts/*` (#391)
   * @param {boolean} [options.resources=true] - serve `resources/*` (#391)
   * @param {number} [options.maxBatchSize=25] - largest JSON-RPC batch accepted (#428)
   */
  constructor({
    name,
    version,
    logger = console,
    fetchDiscovery = null,
    prompts = true,
    resources = true,
    maxBatchSize = MAX_BATCH_SIZE,
  } = {}) {
    this.name = name;
    this.version = version;
    this.logger = logger;
    this.fetchDiscovery = fetchDiscovery;
    this.maxBatchSize = maxBatchSize;
    this.promptsEnabled = prompts;
    this.resourcesEnabled = resources && typeof fetchDiscovery === 'function';
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

  /**
   * Starts an SSE-based HTTP server for MCP transport (#391).
   *
   * Accepts JSON-RPC POST requests at `/mcp` and returns responses
   * as JSON-RPC over HTTP POST. This enables browser-based and HTTP-client
   * MCP integrations alongside the stdio transport.
   *
   * @param {object} options
   * @param {number} [options.port=0] - port to listen on (0 = auto-assign)
   * @param {string} [options.host='127.0.0.1'] - host to bind
   * @returns {Promise<{server: object, port: number, close: () => Promise<void>}>}
   */
  async startSSE({ port = 0, host = '127.0.0.1' } = {}) {
    const server = createServer(async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/mcp') {
        let body = '';
        for await (const chunk of req) body += chunk;

        let reqObj;
        try {
          reqObj = JSON.parse(body);
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }),
          );
          return;
        }

        if (Array.isArray(reqObj)) {
          const out = await this._runBatch(reqObj);
          if (Array.isArray(out) && out.length === 0) {
            // A batch of only notifications is answered with nothing at all.
            res.writeHead(204);
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
          }
          return;
        }

        const id = reqObj.id;
        // Override _write to capture responses and send them as JSON-RPC.
        const originalStdout = this._stdout;
        const captured = [];
        this._open = true;
        this._stdout = {
          write: chunk => captured.push(chunk.toString()),
          on: () => {},
          off: () => {},
        };
        try {
          await this._handleRequest(reqObj);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          for (const chunk of captured) res.write(chunk);
          res.end();
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } }),
          );
        } finally {
          this._stdout = originalStdout;
          this._open = false;
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this._sseServer = server;
    return new Promise(resolve => {
      server.listen(port, host, () => {
        const addr = server.address();
        resolve({
          server,
          port: addr.port,
          close: async () => {
            await server.close();
          },
        });
      });
    });
  }

  /**
   * Sends an SSE event to the connected client.
   *
   * @param {object} res - the HTTP response object
   * @param {object} msg - the JSON-RPC message to send as an SSE event
   */
  _sendSSE(res, msg) {
    const data = JSON.stringify(msg);
    res.write(`data: ${data}\n\n`);
  }

  /**
   * Stops the SSE HTTP server if one was started.
   */
  async stopSSE() {
    if (this._sseServer) {
      await new Promise(r => this._sseServer.close(r));
      this._sseServer = null;
    }
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

    // #428: a batch is an array of requests, answered with an array of
    // responses (nothing at all when every member is a notification).
    if (Array.isArray(req)) {
      const out = await this._runBatch(req);
      if (!Array.isArray(out)) this._sendError(null, out.error.code, out.error.message);
      else if (out.length > 0) this._write(`${JSON.stringify(out)}\n`);
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

  /** Runs a JSON-RPC batch (#428); see processBatch for the return shape. */
  _runBatch(batch) {
    return processBatch(batch, req => this._handleRequest(req), { maxSize: this.maxBatchSize });
  }

  /**
   * The capability set advertised by `initialize` (#391).
   *
   * Mirrors the gates in `_handleSemantic` exactly: a client that reads
   * `prompts` or `resources` here expects those methods to be answered, so the
   * two must never diverge. `resources` is withheld unless there is a
   * facilitator endpoint to resolve `x402://catalog/...` URIs against.
   *
   * @returns {{tools: object, prompts?: object, resources?: object}}
   */
  _capabilities() {
    const capabilities = { tools: {} };
    if (this.promptsEnabled) capabilities.prompts = {};
    if (this.resourcesEnabled) capabilities.resources = {};
    return capabilities;
  }

  async _handleRequest(req) {
    if (req.method === 'initialize') {
      // #169: negotiate rather than hardcode. The client names the revision it
      // wants; per the spec the server answers with that same revision when it
      // supports it, and otherwise counter-offers one it does support (the
      // newest handshake-era revision) for the client to accept or refuse.
      // `null` is used for "the client named a version we do not implement" so
      // a counter-offer is never mistaken for agreement.
      const requested = req.params?.protocolVersion;
      const agreed = SUPPORTED_PROTOCOL_VERSIONS.find(v => v === requested) ?? null;
      if (requested !== undefined && !agreed) {
        this.logger.warn?.(
          `mcp: client requested unsupported protocol version ${JSON.stringify(requested)}; ` +
            `answering with ${LATEST_PROTOCOL_VERSION} (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
        );
      }
      this._sendResult(req.id, {
        protocolVersion: agreed ?? LATEST_PROTOCOL_VERSION,
        serverInfo: { name: this.name, version: this.version },
        capabilities: this._capabilities(),
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
    } else if (await this._handleSemantic(req)) {
      // prompts/* and resources/* were dispatched.
    } else {
      // A genuinely unknown METHOD is a protocol problem, so it keeps the
      // -32601 (method not found) code — distinct from an unknown tool, which
      // is invalid params.
      if (req.id !== undefined) {
        this._sendError(req.id, -32601, 'Method not found');
      }
    }
  }

  /**
   * Dispatches `prompts/*` and `resources/*` (#391).
   *
   * Split out of `_handleRequest` because these follow the same two-tier error
   * contract as tools — an unknown prompt name or a malformed argument is an
   * `isError: true` result the agent can read and act on, not a JSON-RPC error
   * — and duplicating that in the main if-chain is how the tiers drift apart.
   *
   * @param {object} req
   * @returns {Promise<boolean>} true when the method was handled here
   */
  async _handleSemantic(req) {
    const { method, id, params } = req;
    if (!method.startsWith('prompts/') && !method.startsWith('resources/')) return false;

    // A capability that is not advertised must not be answered as if it worked.
    // These fall through to -32601, which tells the client to re-read
    // `initialize` rather than to retry.
    if (method.startsWith('prompts/') && !this.promptsEnabled) return false;
    if (method.startsWith('resources/') && !this.resourcesEnabled) return false;

    const args = params?.arguments ?? {};
    try {
      let result;
      if (method === 'prompts/list') {
        result = listPrompts();
      } else if (method === 'prompts/get') {
        result = getPrompt(params?.name, args);
      } else if (method === 'resources/list') {
        result = listResources();
      } else if (method === 'resources/templates/list') {
        result = listResourceTemplates();
      } else if (method === 'resources/read') {
        result = await readResource(params?.uri, {
          fetchDiscovery: this.fetchDiscovery,
        });
      } else {
        return false; // a prompts/ or resources/ method we do not implement
      }
      // #198 applies here too: a frame with no id is a notification and is never
      // answered, not even with a result. The work is still done so a malformed
      // argument is logged rather than silently accepted.
      if (id !== undefined) this._sendResult(id, result);
      return true;
    } catch (err) {
      this._sendSemanticError(id, err);
      return true;
    }
  }

  /**
   * Reports a prompts/resources failure in the right tier.
   *
   * A bad argument is a tool error (`isError: true` result), matching the
   * documented contract. An unexpected throw stays a -32603, so a bug here is
   * never mistaken for a caller mistake.
   *
   * @param {unknown} id
   * @param {Error & {isToolError?: boolean, payload?: unknown}} err
   */
  _sendSemanticError(id, err) {
    if (id === undefined) {
      // #198: a notification is never answered, not even with an error.
      this.logger.error?.(`mcp: notification failed: ${err?.message ?? err}`);
      return;
    }
    if (err instanceof McpInputError || err?.isToolError) {
      this._sendResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(err.payload || { message: err.message }, null, 2),
          },
        ],
        isError: true,
      });
      return;
    }
    this._sendError(id, -32603, err && err.message ? err.message : String(err));
  }

  _sendResult(id, result) {
    // #198: a result frame without an id answers a notification. JSON-RPC
    // forbids that, and JSON.stringify would drop the undefined key and emit
    // a message a strict client must treat as malformed — refuse instead.
    if (id === undefined) {
      this.logger.error?.('mcp: refusing to send a result with no id (request was a notification)');
      return;
    }
    this._emit({ jsonrpc: '2.0', id, result });
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
    this._emit({ jsonrpc: '2.0', id, error });
  }

  /** Puts a response frame on the wire, or hands it to the batch it belongs to (#428). */
  _emit(frame) {
    const sink = currentBatchSink();
    if (sink) sink.push(frame);
    else this._write(`${JSON.stringify(frame)}\n`);
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
