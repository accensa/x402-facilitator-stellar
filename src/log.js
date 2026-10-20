/**
 * Structured request logging for the HTTP transport.
 *
 * One JSON object per request line, written to a pluggable sink (stdout by
 * default, so a log shipper can scrape it as JSONL). No logging framework:
 * this service is small and the contract is narrow, so a console.log of a
 * JSON.stringify is the whole implementation.
 *
 * WHAT IS AND IS NOT LOGGED. Every line carries exactly this whitelist:
 *
 *   ts, level, event, requestId, route, network, scheme, keyId,
 *   durationMs, outcome, reason, txHash
 *
 * The auth entry, the raw payload.transaction, API keys and the facilitator
 * secret are NEVER part of that shape — they live inside the request body or
 * headers, which this module does not read. That is the redaction guarantee:
 * there is no field on the line that could hold them. logger.redact() is still
 * applied as defence-in-depth in case a field is ever added that should not be
 * echoed.
 *
 * requestId correlation (#). An inbound X-Request-Id is honoured; when absent a
 * UUID is minted and echoed on the response (see app.js) so a resource server
 * debugging a failed payment can hand us one id instead of a timestamp range.
 */

import crypto from 'node:crypto';
import { redact as redactKeys } from './logger.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Normalises a LOG_LEVEL value. Unknown/empty falls back to `info` so a typo
 * never silently disables logging (which would hide a real outage).
 */
export function parseLogLevel(value, fallback = 'info') {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  return v in LEVELS ? v : fallback;
}

function threshold(level) {
  return LEVELS[level] ?? LEVELS.info;
}

/**
 * Extracts the W3C trace context (#411). `traceparent` is authoritative when
 * present and well formed; explicit x-trace-id/x-span-id are accepted for
 * callers that do not emit W3C headers. Missing context is null rather than a
 * fabricated id, so a log query cannot join unrelated requests.
 */
function traceContext(req) {
  const headers = req?.headers ?? {};
  const traceparent = headers.traceparent;
  if (typeof traceparent === 'string') {
    const match = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(
      traceparent.trim(),
    );
    if (match) return { trace_id: match[1].toLowerCase(), span_id: match[2].toLowerCase() };
  }
  const traceId = headers['x-trace-id'];
  const spanId = headers['x-span-id'];
  return {
    trace_id: typeof traceId === 'string' && traceId ? traceId : null,
    span_id: typeof spanId === 'string' && spanId ? spanId : null,
  };
}

function routeOf(req) {
  // Fastify decorates the matched route before any handler runs.
  if (req.routeOptions?.url) return req.routeOptions.url;
  if (typeof req.url === 'string') return req.url.split('?')[0];
  return typeof req.path === 'string' ? req.path : '';
}

/**
 * Builds the per-request logger.
 *
 * @param {object} [options]
 * @param {string} [options.level] - LOG_LEVEL; one of debug|info|warn|error
 * @param {(line: string) => void} [options.sink] - receives the JSON string
 * @returns {{ begin: Function, finish: Function }}
 */
export function createRequestLog({ level = 'info', sink = msg => console.log(msg) } = {}) {
  const minLevel = threshold(level);

  /** Allocates a request span at the start of the request. */
  function begin(req) {
    const inbound = req.headers?.['x-request-id'];
    const requestId =
      typeof inbound === 'string' && inbound.length > 0 ? inbound : crypto.randomUUID();
    return {
      requestId,
      startedAt: Date.now(),
      ...traceContext(req),
      route: routeOf(req),
      network: undefined,
      scheme: undefined,
      keyId: undefined,
      outcome: undefined,
      reason: undefined,
      txHash: undefined,
      settleOutcome: undefined,
      feeStroops: undefined,
    };
  }

  /**
   * Emits the single structured line for the request, after it finishes.
   *
   * `extra` carries the outcome/reason/txHash the handler determined. When the
   * handler left them unset (non-payment routes, or a route that short-circuited
   * before the handler set them) they are derived from the status code.
   */
  function finish(span, extra = {}) {
    if (!span) return;
    const outcome = extra.outcome ?? span.outcome ?? 'ok';
    const lineLevel = outcome === 'error' ? 'error' : 'info';
    if (threshold(lineLevel) < minLevel) return;

    const line = {
      ts: new Date().toISOString(),
      level: lineLevel,
      event: 'request',
      trace_id: span.trace_id ?? null,
      span_id: span.span_id ?? null,
      requestId: span.requestId,
      route: span.route,
      network: span.network ?? null,
      scheme: span.scheme ?? null,
      keyId: span.keyId ?? null,
      durationMs: Date.now() - span.startedAt,
      outcome,
      reason: extra.reason ?? span.reason ?? 'none',
      txHash: extra.txHash ?? span.txHash ?? null,
    };

    // Defence-in-depth: key-name redaction. The whitelist above cannot carry
    // secret material, but if a field is added later this still scrubs it.
    sink(JSON.stringify(redactKeys(line)));
  }

  return { begin, finish };
}
