/**
 * OpenTelemetry initialization (#tracing).
 *
 * Wires the SDK once at process startup so every boundary is traced:
 *
 *   - the inbound HTTP server (Fastify on Node's http), where the upstream
 *     caller's W3C `traceparent` is extracted and continued;
 *   - the outbound HTTP calls — Horizon/Soroban RPC (reached through the
 *     wrapped global `fetch`, which dials via the npm `undici` client) and the
 *     background webhook delivery — where the current span context is injected
 *     back out as `traceparent`;
 *   - the scheme call itself (verify/settle), wrapped in a child span so a
 *     latency spike can be attributed to the chain rather than the transport.
 *
 * Propagation is W3C Trace Context, the default and the only one we claim to
 * support: an upstream span that arrives here is the parent of the server span,
 * and the server span is the parent of every downstream call we make.
 *
 * The scheme (ExactStellarScheme) is upstream and is intentionally NOT
 * reimplemented — we only instrument the service around it (house rule). Its
 * work shows up as the child `facilitator.verify` / `facilitator.settle`
 * spans, plus the undici spans for the RPC it makes.
 *
 * Disabled wholesale with TRACING_ENABLED=false (or OTEL_SDK_DISABLED=true) so
 * the rest of the code can call getTracer()/getActiveSpan() unconditionally
 * without paying for an SDK that isn't running.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace as apiTrace, trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';

/** @type {import('@opentelemetry/sdk-node').NodeSDK | null} */
let sdk = null;

/**
 * Parses an OTLP header string ("k1=v1,k2=v2") into an object, for backends
 * like Honeycomb that authenticate via a header (x-honeycomb-team).
 * @param {string | undefined} raw
 * @returns {Record<string, string>}
 */
function parseHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Resolves the OTLP traces endpoint. Honours the traces-specific override first,
 * then the generic OTLP endpoint, then the Jaeger all-in-one default. Appends
 * the OTLP/HTTP path when only an origin is given.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined} undefined → exporter uses its own default
 */
function resolveOtlpEndpoint(env) {
  const given = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!given) return undefined; // exporter default: http://localhost:4318/v1/traces
  if (given.endsWith('/v1/traces')) return given;
  return `${given.replace(/\/+$/, '')}/v1/traces`;
}

/**
 * Initializes the OpenTelemetry SDK. Idempotent: a second call returns the
 * already-running instance and does not start a new one.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('@opentelemetry/sdk-node').NodeSDK | null}
 */
export function initTracing(env = process.env) {
  if (sdk) return sdk;
  if (env.TRACING_ENABLED === 'false' || env.OTEL_SDK_DISABLED === 'true') {
    return null;
  }

  const serviceName =
    env.OTEL_SERVICE_NAME ?? env.FACILITATOR_SERVICE_NAME ?? 'x402-facilitator-stellar';

  const endpoint = resolveOtlpEndpoint(env);
  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);

  const exporter = new OTLPTraceExporter(
    endpoint || Object.keys(headers).length ? { url: endpoint, headers } : {},
  );

  sdk = new NodeSDK({
    serviceName,
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    textMapPropagator: new W3CTraceContextPropagator(),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Inbound server spans are created manually in app.js (see withRequestSpan):
        // the http instrumentation cannot reliably patch Fastify v5's ESM module,
        // and doing it manually lets us extract the W3C traceparent and attach
        // tenant/route metadata in one place without a duplicate span.
        '@opentelemetry/instrumentation-http': { enabled: false },
        '@opentelemetry/instrumentation-fastify': { enabled: false },
        // Outbound: the wrapped global fetch and the webhook delivery both dial
        // through the npm `undici` client, which is what this instruments and
        // uses to inject traceparent into the outgoing request.
        '@opentelemetry/instrumentation-undici': { enabled: true },
        // Keep the trace free of filesystem noise.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  return sdk;
}

/** The tracer used by the transport for scheme-level spans. */
export const tracer = apiTrace.getTracer('x402-facilitator-stellar');

/**
 * Annotates the currently active span with arbitrary key-value attributes.
 *
 * @param {Record<string, unknown>} attrs
 */
export function annotateSpan(attrs) {
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [key, value] of Object.entries(attrs)) {
    span.setAttribute(key, value);
  }
}

/**
 * Runs `fn` inside an active server request span extracted from incoming W3C headers.
 *
 * @template T
 * @param {string} name
 * @param {import('fastify').FastifyRequest} req
 * @param {(span: import('@opentelemetry/api').Span) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRequestSpan(name, req, fn) {
  const parentCtx = propagation.extract(context.active(), req.headers);
  return tracer.startActiveSpan(
    name,
    {
      attributes: {
        'http.method': req.method,
        'http.route': req.routeOptions?.url ?? req.url?.split('?')[0],
        'tenant.id': req.keyId ?? 'open',
      },
    },
    parentCtx,
    async span => {
      try {
        return await fn(span);
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Instruments an upstream scheme call in a dedicated child span.
 *
 * @template T
 * @param {string} op
 * @param {string} network
 * @param {() => Promise<T>} fn
 * @param {Record<string, unknown>} [extraAttrs={}]
 * @returns {Promise<T>}
 */
export async function tracedSchemeCall(op, network, fn, extraAttrs = {}) {
  return tracer.startActiveSpan(`facilitator.${op}`, async span => {
    span.setAttribute('x402.network', network);
    for (const [key, value] of Object.entries(extraAttrs)) {
      span.setAttribute(key, value);
    }
    try {
      const result = await fn();
      if (result && result.transaction) {
        span.setAttribute('x402.transaction.id', result.transaction);
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
