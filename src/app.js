/**
 * The HTTP surface. The full inventory, with each route's authentication and
 * rate-limit posture, is the table in docs/AUTHENTICATION.md — and
 * test/docs-routes.test.js fails if this file registers a route that table does
 * not list, so the two are updated together:
 *
 *   - payments:      POST /verify, POST /settle (API key, metered)
 *   - discovery:     GET /supported, GET /discovery/resources,
 *                    GET /discovery/search (public reads)
 *   - cataloging:    POST /discovery/resources (manual, API key), plus the
 *                    automatic off-path cataloging of every successful
 *                    /verify and /settle — see processCataloging
 *   - settlements:   GET /settlements/:idempotencyKey (#10) and
 *                    GET /settlements/:idempotencyKey/events (#130)
 *   - metering:      GET /usage (API key, strict — the one route that refuses
 *                    open mode)
 *   - operational:   GET /healthz (liveness), GET /readyz (readiness),
 *                    GET /metrics (Prometheus text)
 *   - preflights:    OPTIONS on every CORS-enabled route above
 *   - operator-only, registered only when a DeadLetterStore is configured:
 *                    /admin/dlq* (see src/dlq/routes.js)
 *
 * @x402/core ships no facilitator router — it gives you x402Facilitator with
 * verify(), settle() and getSupported(), and the transport is yours. This file
 * is that transport and nothing else.
 *
 * Conformance is judged at the wire level (RFP §3.6): reviewers point stock SDK
 * code at the deliverable rather than read a conformance claim. So the rules
 * here are narrow and deliberate:
 *
 *   - the spec's `payload: {transaction}` shape is accepted verbatim, unwrapped
 *     and un-renamed;
 *   - every rejection carries a non-null reason code, including transport-level
 *     ones, so an agent can branch on a code instead of parsing prose;
 *   - responses are passed through from the scheme untouched.
 *
 * Transport (#119): Fastify rather than Express. The routing/parsing core is
 * what showed up in load profiling at high RPS; Fastify's schema-compiled
 * handlers and lower-allocation JSON path address exactly that. Every behaviour
 * the wire contract had is preserved: status codes, reason codes, response
 * shapes and headers are byte-for-byte what they were under Express — the
 * framework changed, the surface did not.
 *
 * Body validation is Fastify's built-in AJV compiler with `attachValidation`:
 * schemas reject structurally impossible bodies before any handler code runs,
 * but the handler still shapes the rejection, because /verify and /settle
 * disagree on what a failure body looks like (isValid/invalidReason vs.
 * success/errorReason/transaction/network) and AJV must not flatten that.
 *
 * Separated from server.js so the surface can be built and exercised without
 * binding a port, holding a real signer, or spawning a subprocess. server.js is
 * the process entrypoint and does nothing this file does.
 */
import { registerDlqRoutes } from './dlq/routes.js';
import crypto from 'node:crypto';

/**
 * Stable, dependency-free serialization of the params that shape a discovery
 * response, so the ETag is stable across request encodings of the same filter.
 * Keys are sorted, arrays are sorted, and undefined/null are dropped.
 *
 * @param {object} params - the parsed query parameters that shape the response
 *   (a repeated query key arrives as an array)
 * @returns {string} canonical JSON; two encodings of the same filter always
 *   produce the same string, which is what makes the ETag stable
 */
function canonicalizeDiscoveryParams(params) {
  const out = {};
  for (const key of Object.keys(params || {}).sort()) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    out[key] = Array.isArray(v) ? v.slice().sort() : String(v);
  }
  return JSON.stringify(out);
}

/**
 * Weak ETag for a discovery response (#200). Keyed on BOTH the monotonic
 * catalog version (any write changes it, so it invalidates every cached
 * variant at once) AND the full parameter set (different filters are different
 * representations and must never share a validator).
 *
 * @param {number} catalogVersion - the catalog's monotonic write counter; a
 *   missing getVersion() falls back to 0, which still leaves the parameter
 *   hash doing the filter isolation
 * @param {object} params - response-shaping parameters, canonicalised before
 *   hashing so key order never changes the validator
 * @returns {string} a weak ETag of the form `W/"<version>-<hash>"`
 */
function discoveryETag(catalogVersion, params) {
  const hash = crypto
    .createHash('sha1')
    .update(canonicalizeDiscoveryParams(params))
    .digest('base64url')
    .replace(/=+$/, '');
  return `W/"${catalogVersion}-${hash}"`;
}

import Fastify from 'fastify';
import compress from '@fastify/compress';
import { validateForCatalog } from './catalog/validation.js';
import { createAuditLogger } from './audit.js';
import { createReadinessChecker } from './readiness.js';
import { validatePaymentBody, validatePaymentFields } from './request-validation.js';
import { createRequestLog } from './log.js';
import { createMetrics } from './metrics.js';
import { createIpPseudonymizer } from './ip.js';

import { lockKeyFor } from './distributed-lock.js';
import { requestState } from './request-state.js';
import { signerMetrics } from './metrics.js';
import { buildSettlementStore } from './store/index.js';
import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';
import { tracer } from './tracing.js';

/** 256kb body cap, carried over unchanged from the Express transport. */
const BODY_LIMIT_BYTES = 256 * 1024;

/**
 * AJV schema for both payment routes. Deliberately loose: it asserts only the
 * structure the transport itself branches on — the same contract as
 * request-validation.js, expressed declaratively. The transaction XDR,
 * signatures and amounts inside paymentPayload are the scheme's contract, not
 * the transport's; a schema strict enough to reject a payload the scheme would
 * have accepted would be a conformance failure, not hardening.
 */
const PAYMENT_BODY_SCHEMA = {
  type: 'object',
  required: ['paymentPayload', 'paymentRequirements'],
  properties: {
    paymentPayload: { type: 'object' },
    paymentRequirements: {
      type: 'object',
      required: ['scheme', 'network'],
      properties: {
        scheme: { type: 'string', minLength: 1 },
        network: { type: 'string', minLength: 1 },
      },
    },
  },
};

/**
 * Adds attributes to the span that is currently active and does nothing when
 * there is none. The surrounding request span is opened by withRequestSpan (and
 * the scheme call's own span by tracedSchemeCall), so this is the cheap way for
 * a route to tag itself — route name, tenant id — without threading the span
 * through every handler signature.
 *
 * @param {Record<string, string|number|boolean>} attrs - OpenTelemetry
 *   attribute name/value pairs to set on the active span
 */
function annotateSpan(attrs) {
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [key, value] of Object.entries(attrs)) {
    span.setAttribute(key, value);
  }
}

/**
 * Runs `fn` inside a fresh span named for the request, so every handler in a
 * route shares one parent span regardless of how many scheme calls it makes.
 *
 * The W3C trace context is extracted from the inbound headers first, so a
 * caller that already has a trace (an agent SDK, a gateway) gets one continuous
 * trace instead of a disconnected one. Errors mark the span failed and are
 * re-thrown unchanged — this wrapper observes, it never swallows.
 *
 * @param {string} name - span name, e.g. `HTTP POST /settle`
 * @param {object} req - Fastify request; headers supply the parent context and
 *   method/route/tenant.id become span attributes
 * @param {(span: object) => Promise<*>} fn - the request body
 * @returns {Promise<*>} whatever `fn` resolves to
 */
async function withRequestSpan(name, req, fn) {
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
 * Wraps one facilitator call (verify or settle) in its own child span, so the
 * latency that belongs to Stellar/Horizon is separable from the time this
 * process spends on authentication, metering and persistence.
 *
 * A successful settle/verify result carries the transaction id, which is
 * recorded as `x402.transaction.id` — the join key between this span and the
 * on-chain transaction a support engineer will look at next.
 *
 * @param {string} op - 'verify' or 'settle'
 * @param {string} network - CAIP-2 network identifier, recorded as `x402.network`
 * @param {() => Promise<object>} fn - the facilitator call itself
 * @param {object} [extraAttrs] - additional span attributes (tenant id, ...)
 * @returns {Promise<object>} the facilitator's response, passed through untouched
 */
async function tracedSchemeCall(op, network, fn, extraAttrs = {}) {
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

/**
 * Builds the Fastify app: hooks, auth, CORS, every route, and the single error
 * boundary. Separated from server.js so the surface can be built and exercised
 * without binding a port, holding a real signer or spawning a subprocess.
 *
 * Takes its collaborators rather than reaching for module state, which is what
 * makes the surface testable: a test can supply a facilitator that throws, a
 * rate limiter already at its ceiling, or a catalog that rejects a write,
 * without a network, a keypair or a subprocess.
 *
 * `signers` is deliberately not a parameter — no route reads it. The addresses
 * reach the wire through facilitator.getSupported(); server.js keeps them only
 * to print the boot banner. (`extras.signers` is the separate fee-payer map
 * used solely to label the signer-inflight gauge.)
 *
 * @param {object} config - resolved config from resolveConfig()
 * @param {{verify: Function, settle: Function, getSupported: Function}} facilitator
 * @param {object} rateLimiter - RateLimiter, or a stub with the same surface
 * @param {{upsertResource: Function, listResources: Function}} catalog
 * @param {{keyFor: Function, begin: Function, complete: Function}} [idempotency]
 *   optional idempotency store for /settle; absent means in-memory only — the
 *   response is then derived from the settlement record instead of replayed
 * @param {object} [extras] - optional collaborators. Everything below has a
 *   working default, which is what keeps a bare `createApp(config, ...)` usable
 *   in tests:
 *   - distributedLock (#116): Redlock-backed lock serialising state transitions
 *   - webhooks (#117): asynchronous webhook dispatcher
 *   - dlq: DeadLetterStore plus publish function; its operator routes are
 *     registered only when present (src/dlq/routes.js)
 *   - failoverHealth (#126): region-aware failover health checker
 *   - settlementStore: overrides the store built from config (Postgres when
 *     DATABASE_URL is set, in-memory otherwise)
 *   - logger: request-log sink; injected so tests can capture the line
 *   - metrics: metrics registry; injected so tests can read counters directly
 *   - signers: per-network fee-payer map, used for signer-inflight metrics only
 *   - audit: audit writer override (default createAuditLogger)
 *   - readiness: readiness checker override
 *   - breakerStates: breaker-state reader for the readiness probe (#105)
 *   - ipPseudonymizer (#204): maps a resolved client IP to a stable,
 *     non-reversible digest before any bucket or audit record sees it
 *   - serveMetrics: false moves /metrics off this listener (server.js serves it
 *     on a separate port when METRICS_PORT is set)
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function createApp(
  config,
  facilitator,
  rateLimiter,
  catalog,
  idempotency,
  extras = {},
) {
  const {
    distributedLock = null,
    webhooks = null,
    dlq = null,
    failoverHealth = null,
    settlementStore = extras.settlementStore ?? buildSettlementStore(config),
  } = extras;

  // Observability collaborators. Both are injectable so tests can capture the
  // structured log line and inspect the metrics registry without a stdout scraper
  // or a listener; in production server.js supplies real ones (and binds the
  // metrics port when METRICS_PORT is set).
  const logger = extras.logger ?? createRequestLog({ level: config.logLevel ?? 'info' });
  const metrics = extras.metrics ?? createMetrics();
  const signers = extras.signers ?? {};
  // #204: IP pseudonymisation is a single choke point. server.js passes a
  // keyed hasher; a bare config (tests) falls back to a plain digest. Either
  // way no raw address reaches a rate-limit bucket, an audit record or a log.
  const ipPseudonymizer = extras.ipPseudonymizer ?? createIpPseudonymizer();

  // Seed the signer-inflight series at zero for every configured signer so the
  // gauge exists before the pool lands (#9). The settle path flips it to one
  // while a settlement is in flight.
  for (const [network, signer] of Object.entries(signers)) {
    if (signer) metrics.setSignerInflight({ network, signer, value: 0 });
  }

  // Whether /metrics is served on this (public) listener. When METRICS_PORT is
  // set, server.js runs a separate listener for it and passes serveMetrics:false.
  const serveMetrics = extras.serveMetrics !== false;

  const app = Fastify({
    // Client IP resolution. Unset leaves Fastify's default (off), correct where
    // the port is published directly — local development and docker-compose.
    // Never "true": that trusts the leftmost X-Forwarded-For entry the client
    // wrote itself. See docs/DEPLOYMENT.md for the topology per environment.
    trustProxy: config.trustProxy,

    bodyLimit: BODY_LIMIT_BYTES,

    // Fastify's own pino logging stays off so there is exactly one choke point
    // for what hits the log: the structured line emitted by the hooks below.
    logger: false,

    // AJV options: strict bodies are rejected, never silently coerced or
    // stripped — removeAdditional off means an unknown field cannot vanish on
    // its way to the scheme, and coerceTypes off means a numeric network name
    // is rejected rather than stringified into one.
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        allErrors: true,
      },
    },
  });

  /**
   * Compression (#69), registered with the plugin default 1kb threshold rather
   * than a custom one, after measuring the actual payloads (see the PR):
   *
   *   - GET /discovery/resources (full 100-entry page): 71,587 B -> 2,801 B
   *   - GET /discovery/search (ranked results):          71,605 B -> 2,813 B
   *
   * Those are the only responses over a few hundred bytes — the settlement hot
   * path (/verify, /settle, /supported, /usage) stays well under 1kb and is
   * deliberately left uncompressed so we don't burn CPU on the hot path to save
   * nothing. gzip wins ~96% on the discovery reads because they are large JSON
   * with heavily repeated keys, which is exactly the case gzip is good at.
   *
   * The plugin emits `Vary: Accept-Encoding` on compressed responses, so a
   * shared cache in front of the service cannot serve a gzipped body to a
   * client that did not ask for one; a request without `Accept-Encoding` gets
   * the same valid uncompressed body as before. Brotli is out of scope by
   * choice — gzip is what the stock x402 clients understand.
   */
  // Must be awaited: Fastify applies a registered plugin's hooks to routes
  // registered after it only once its register promise resolves (fastify-plugin
  // or not), so registering the routes below without this await would silently
  // ship an uncompressed surface.
  await app.register(compress);

  /**
   * Request logging (#78/#86 lineage): one redacted line per request. The
   * middleware from logger.js speaks the Node req/res pair; Fastify exposes
   * exactly that as request.raw / reply.raw, so the same redaction choke point
   * serves both frameworks unchanged.
   */
  // In-flight request gauge, decorated onto the instance rather than exported:
  // server.js reads it from the forced-exit path to report how much work a
  // shutdown deadline is about to cut off. Incremented in onRequest and
  // decremented in onResponse, clamped at zero so a stray decrement cannot
  // drive it negative.
  let activeRequestCount = 0;
  app.decorate('getInFlightCount', () => activeRequestCount);

  app.addHook('onRequest', (req, reply, done) => {
    activeRequestCount++;
    const span = logger.begin(req);
    req.span = span;
    reply.header('X-Request-Id', span.requestId);
    // Async-local request state for the shutdown drain (#248).
    requestState.run({ submitted: false }, () => {
      done?.();
    });
  });

  /**
   * Emits the single structured line per request and records metrics, after the
   * response is on its way. Handlers populate span fields (network, scheme,
   * keyId, outcome, reason, txHash, settleOutcome, feeStroops); anything they
   * left unset is derived from the status code so every request still yields one
   * complete line.
   *
   * Operational endpoints (/metrics, /healthz, /readyz) are logged but excluded
   * from the request counter and duration histogram so the payment metrics stay
   * semantically about payments.
   *
   * Entries are registered route patterns — the value logger.begin() reads off
   * req.routeOptions.url. A pattern that does not match what Fastify registered
   * silently stops excluding anything, so keep these in step with the route
   * declarations below.
   */
  const OPERATIONAL_ROUTES = new Set(['/metrics', '/healthz', '/readyz']);
  app.addHook('onResponse', (req, reply, done) => {
    activeRequestCount = Math.max(0, activeRequestCount - 1);
    const span = req.span;
    if (!span) return done?.();

    const status = reply.statusCode;
    const outcome = span.outcome ?? (status >= 500 ? 'error' : status >= 400 ? 'rejected' : 'ok');
    const reason =
      span.reason ?? (status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'none');

    logger.finish(span, { outcome, reason });

    if (!OPERATIONAL_ROUTES.has(span.route)) {
      metrics.incRequests({
        route: span.route,
        network: span.network ?? 'unknown',
        outcome,
        reason: span.reason ?? reason,
      });
      metrics.observeRequestDuration({
        route: span.route,
        network: span.network ?? 'unknown',
        durationSeconds: (Date.now() - span.startedAt) / 1000,
      });
      if (span.route === '/settle' && span.settleOutcome) {
        metrics.incSettlements({
          network: span.network ?? 'unknown',
          outcome: span.settleOutcome,
        });
        if (span.settleOutcome === 'settled' && typeof span.feeStroops === 'number') {
          metrics.observeSettlementFee({
            network: span.network ?? 'unknown',
            feeStroops: span.feeStroops,
          });
        }
      }
    }

    done?.();
  });

  // Audit records — who did what (settlements, auth failures, catalog writes) —
  // are a different artifact from the request log: every line carries a
  // `channel: "audit"` marker and goes to stdout, plus AUDIT_LOG_FILE when one
  // is configured. See src/audit.js and docs/AUDIT.md.
  const audit = extras.audit ?? createAuditLogger();

  // Readiness defaults to a real checker over the resolved config. A bare
  // config (tests) carries no per-network signer/RPC data, in which case the
  // probe reports honestly that it has nothing to check rather than pretending
  // to be ready.
  const readiness =
    extras.readiness ??
    (Array.isArray(config.networks) && config.perNetwork
      ? createReadinessChecker(config, {
          breakerStates: extras.breakerStates ?? (() => null),
          catalog,
        })
      : null);

  // Decorated rather than kept local: server.js reads app.readiness during
  // graceful shutdown to flip the probe into its shutting-down state, so the
  // load balancer stops sending new work before the drain starts.
  app.decorate('readiness', readiness);

  /**
   * Security headers (#86), hand-set rather than via helmet.
   *
   * helmet's value is its defaults for a document-serving app; this service
   * returns JSON to programmatic clients and serves no HTML, no cookies and no
   * user-supplied markup, so only two headers do real work here:
   *
   *   - X-Content-Type-Options: nosniff — stops a JSON response being
   *     reinterpreted as something else by a browser.
   *   - Strict-Transport-Security — meaningful for a hosted mainnet deployment
   *     handling payment authorizations; conditional on NODE_ENV=production so
   *     a local HTTP dev server cannot poison a browser's view of localhost.
   *
   * Fastify sends no server-advertising header to suppress (Express's
   * x-powered-by needed an explicit disable; there is nothing equivalent here).
   *
   * Deliberately NOT set:
   *   - Content-Security-Policy — defends against content injection into
   *     documents; no documents are served. If the OpenAPI work adds a Swagger
   *     UI page, that changes the calculus and CSP (plus helmet wholesale)
   *     should be revisited then.
   *   - X-Frame-Options / frame-ancestors — nothing here is framable; there is
   *     no HTML to clickjack.
   */
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (config.nodeEnv === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  /**
   * Hop-count trust proxy (#111 lineage).
   *
   * TRUST_PROXY accepts a hop count, a proxy list, or a proxy-addr preset.
   * Fastify natively understands the string/array forms but has no hop-count
   * mode, so a number is emulated here the way Express resolves it: walk the
   * X-Forwarded-For chain from the connection peer inward, trusting exactly N
   * hops, and report the first untrusted address. Leftmost entries beyond the
   * trusted depth stay attacker-controlled noise and are never believed.
   */
  if (typeof config.trustProxy === 'number') {
    const hops = Math.max(0, Math.floor(config.trustProxy));
    app.addHook('onRequest', async req => {
      const raw = req.headers['x-forwarded-for'] ?? '';
      const forwarded = String(raw)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const chain = [...forwarded, req.socket.remoteAddress];
      const ip = chain[Math.max(0, chain.length - 1 - hops)] ?? req.socket.remoteAddress;
      // configurable so the #204 pseudonymisation hook below can replace it.
      Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    });
  }

  /**
   * Pseudonymise the resolved client IP (#204) before any downstream code can
   * read it. This runs after the hop-count hook above so a numeric TRUST_PROXY
   * resolves the real caller first, and after Fastify has populated `req.ip`
   * for the string/array trust modes.
   *
   * Overriding `req.ip` itself — rather than every call site — is deliberate:
   * the rate limiter (`req.keyId || req.ip`), the audit actor
   * (`ip:${req.ip}`) and the ad-hoc warning all read this one property, so a
   * single replacement is what makes the docs/PRIVACY.md claim true. No
   * downstream code changes are needed, and none can forget to apply it.
   */
  app.addHook('onRequest', async req => {
    const pseudonym = ipPseudonymizer(req.ip);
    if (pseudonym !== undefined && pseudonym !== req.ip) {
      Object.defineProperty(req, 'ip', { value: pseudonym, configurable: true });
    }
  });

  // Headers a browser client must be able to read but which are not
  // CORS-safelisted response headers: without naming them in
  // Access-Control-Expose-Headers they are invisible to browser JavaScript,
  // which would leave the Bazaar cataloguing outcome unreadable from a browser.
  const EXPOSED_HEADERS = [
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
    'Retry-After',
    'EXTENSION-RESPONSES',
  ].join(', ');

  /**
   * CORS (#76), decided per route class rather than globally, because the two
   * classes have opposite risk profiles:
   *
   *   - Public reads (/supported, GET /discovery/resources,
   *     /discovery/search) are unauthenticated and carry no credential worth
   *     protecting, so they default to `*`: a browser-based agent, catalog
   *     explorer or seller checking their own listing needs these.
   *   - Authenticated routes (/verify, /settle, /usage, POST
   *     /discovery/resources) carry an API key. A permissive policy there
   *     invites any web page to send a caller's key somewhere it should not
   *     go, so the default is no grant at all: origins must be explicitly
   *     allowlisted via CORS_ALLOWED_ORIGINS.
   *
   * Authorization is not a safelisted request header, so every browser call to
   * the payment routes triggers a preflight that must be answered with the
   * right Allow-Headers or the request silently fails — hence explicit OPTIONS
   * handlers on both classes, registered without auth so a preflight (which
   * cannot carry an API key) is answered before credentials matter.
   *
   * Hand-set rather than a plugin: the per-class split means a single global
   * config would be fought, and three headers add no dependency surface worth
   * paying for.
   */
  function cors(policy) {
    return async (req, reply) => {
      reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);

      const origin = req.headers.origin;
      const allowlisted = origin && config.cors.allowedOrigins.includes(origin);
      let granted;
      if (policy === 'public') {
        granted = allowlisted ? origin : config.cors.allowedOrigins.length === 0 ? '*' : false;
      } else {
        // Never default-open anything authenticated.
        granted = allowlisted ? origin : false;
      }

      reply.header('Vary', 'Origin');

      if (granted) {
        reply.header('Access-Control-Allow-Origin', granted);
      }
    };
  }

  /**
   * Terminates a CORS preflight with 204.
   *
   * Registered without an auth hook, because a preflight cannot carry an API
   * key: the browser sends OPTIONS with no Authorization header, so gating it
   * behind requireApiKey would fail every browser call to an authenticated
   * route before the real request was ever attempted.
   *
   * @param {'public'|'authenticated'} policy - the route class being preflighted
   */
  function preflight(policy) {
    return async (req, reply) => {
      cors(policy)(req, reply);
      // Answer the preflight even when the origin is not granted: the 204
      // carries no ACAO, so the browser still blocks the actual request —
      // which is the enforcement point, not the preflight status.
      reply.header(
        'Access-Control-Allow-Methods',
        policy === 'public' ? 'GET, OPTIONS' : 'POST, OPTIONS',
      );
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      reply.header('Access-Control-Max-Age', '600');
      return reply.code(204).send();
    };
  }

  /**
   * Catalogs a resource declared in a payment, off the hot path.
   *
   * Cataloging must never delay or fail a payment: the expensive work is
   * enqueued and the payment response returns immediately. A cataloging failure
   * is logged, never surfaced as a payment failure.
   *
   * The `source` records how the resource entered the catalog (#140): a verify
   * ("verify") proves nothing was paid, so the store catalogs it as provisional
   * and expiring; a real settlement ("settle") promotes it to permanent public
   * state. A hand-entered resource is "manual".
   */
  async function processCataloging(req, body, reply, source = 'verify') {
    try {
      const validation = validateForCatalog(body.paymentPayload, body.paymentRequirements);
      const outcome = {};

      if (validation.hardDrop) {
        if (validation.reason === 'missing_or_invalid_discovery_extension') {
          outcome.status = 'not attempted';
        } else {
          outcome.status = 'rejected';
          outcome.code = validation.reason;
          console.warn(`[Catalog] Hard drop: ${validation.reason}`);
        }
      } else {
        const checkResult = await rateLimiter.checkCatalog(req);
        if (!checkResult.allowed) {
          outcome.status = 'rejected';
          outcome.code = 'catalog_rate_limited';
          outcome.reason = checkResult.reason;
          // Never log the address (even pseudonymised) ad hoc — the audit
          // record below carries the pseudonym, and stdout is not a place for
          // caller identifiers (#204).
          console.warn('[Catalog] Rate limit exceeded for caller');
          // Audited as a rejection but never allowed to shape the payment
          // response: the 429/headers belong to the payment limiter, not here.
          audit('rate_limit_rejected', {
            actor: req.keyId ?? `ip:${req.ip}`,
            route: 'catalog',
            reason: checkResult.reason,
            outcome_override: outcome.code,
          });
        } else {
          if (validation.softDrops.length > 0) {
            outcome.status = 'partially landed';
            outcome.code = 'catalog_partial';
            outcome.reason = `Dropped fields: ${validation.softDrops.join(', ')}`;
            console.warn(
              `[Catalog] Soft drops for ${validation.resource.url}: ${validation.softDrops.join(', ')}`,
            );
          } else {
            outcome.status = 'landed';
            outcome.code = 'catalog_success';
          }

          await rateLimiter.recordCatalog(req);

          // Off the hot path. Cataloging must never delay or fail a payment.
          Promise.resolve().then(async () => {
            try {
              const existing = await catalog.getResource?.(
                validation.resource.url,
                validation.resource.toolName ?? null,
              );
              await catalog.upsertResource(validation.resource, source);
              // A public listing being created or overwritten is public state
              // changing — recorded so a spoofed listing can be investigated
              // after the fact.
              audit('catalog_write', {
                actor: req.keyId ?? `ip:${req.ip}`,
                source,
                url: validation.resource.url,
                tool_name: validation.resource.toolName ?? null,
                overwritten: Boolean(existing),
              });
            } catch (err) {
              console.warn(`[Catalog] Async cataloging failed: ${err.message}`);
            }
          });
        }
      }

      reply.header(
        'EXTENSION-RESPONSES',
        Buffer.from(JSON.stringify({ bazaar: outcome })).toString('base64'),
      );
    } catch (err) {
      // Cataloging must never fail a payment, so the exception is logged but
      // never re-thrown. It must also never leave the caller without their
      // cataloging outcome: EXTENSION-RESPONSES is the only channel a seller
      // has to learn what the Bazaar did, so a malformed discovery extension
      // that throws here still surfaces an explicit `not attempted` rather
      // than silently omitting the header entirely.
      console.error('[Catalog] Unhandled error during processCataloging:', err);
      try {
        reply.header(
          'EXTENSION-RESPONSES',
          Buffer.from(JSON.stringify({ bazaar: { status: 'not attempted' } })).toString('base64'),
        );
      } catch (headerErr) {
        console.error('[Catalog] Failed to write EXTENSION-RESPONSES fallback:', headerErr);
      }
    }
  }

  /**
   * Caller authentication.
   *
   * Unset means open. That is the correct default for a free testnet instance —
   * the RFP requires testnet be usable without friction — and it is documented
   * rather than silent: the server logs at boot when it is running open.
   */
  async function requireApiKey(req, reply) {
    if (config.apiKeys.length === 0) return;

    // The presented key material itself is deliberately never recorded.
    const reject = reason => {
      audit('auth_failure', { actor: `ip:${req.ip}`, reason });
      reply
        .code(401)
        .send({ isValid: false, invalidReason: reason, invalidMessage: 'unauthorized', reason });
    };

    const authHeader = req.headers.authorization;
    if (!authHeader) return reject('missing_auth_header');
    if (authHeader === 'Bearer' || authHeader === 'Bearer ') {
      return reject('malformed_auth_header');
    }

    let presentedKey = '';
    if (authHeader.startsWith('Bearer ')) {
      presentedKey = authHeader.substring(7);
    } else if (!authHeader.includes(' ')) {
      presentedKey = authHeader;
    } else {
      return reject('malformed_auth_header');
    }

    if (!presentedKey || presentedKey.includes(' ')) {
      return reject('malformed_auth_header');
    }

    const presentedHash = crypto.createHash('sha256').update(presentedKey).digest();

    for (const apiKey of config.apiKeys) {
      if (
        presentedHash.length === apiKey.hash.length &&
        crypto.timingSafeEqual(presentedHash, apiKey.hash)
      ) {
        // For the structured request log (keyId from #5).
        if (req.span) req.span.keyId = apiKey.id;

        req.keyId = apiKey.id.toUpperCase();
        return;
      }
    }

    reject('invalid_api_key');
  }

  /**
   * The strict variant of the gate above: refuses open mode instead of
   * tolerating it.
   *
   * Used where the route only makes sense for an identified caller — GET /usage
   * meters a specific key, and the DLQ operator API reads and discards in-flight
   * settlement notifications. Open mode is answered with 401 and the distinct
   * reason `open_mode_usage_forbidden`, so a caller can tell "this instance has
   * no keys configured" from "my key was rejected".
   */
  async function requireApiKeyStrict(req, reply) {
    if (config.apiKeys.length === 0) {
      reply.code(401).send({
        isValid: false,
        invalidReason: 'open_mode_usage_forbidden',
        invalidMessage: 'unauthorized',
      });
      return;
    }
    return requireApiKey(req, reply);
  }

  /**
   * Records a rate-limit rejection in the audit trail before answering it.
   *
   * Rejections are abuse signals rather than noise, so they are auditable — but
   * the actor recorded is the authenticated keyId or the pseudonymised address,
   * never the presented key material.
   *
   * @param {string} route - the route pattern the rejection belongs to
   * @param {object} checkResult - limiter state; also shapes the 429 reply
   * @param {object} [extra] - extra audit fields (e.g. a catalog outcome code)
   * @returns {object|null} the 429 reply, already sent (see handleRateLimit)
   */
  function rejectRateLimited(req, reply, route, checkResult, extra = {}) {
    audit('rate_limit_rejected', {
      actor: req.keyId ?? `ip:${req.ip}`,
      route,
      reason: checkResult.reason,
      ...extra,
    });
    return handleRateLimit(reply, checkResult);
  }

  /**
   * Emits the RateLimit-* headers for a completed check and, when the check
   * failed, the 429 body.
   *
   * The headers are written on allowed requests too, so a caller can pace
   * itself against the budget instead of discovering the limit by hitting it.
   *
   * @param {object} checkResult - limiter state (limit/remaining/resetAt/allowed)
   * @returns {object|null} the 429 reply when the request was rejected, null
   *   when it was allowed so the caller falls through to its normal work
   */
  function handleRateLimit(reply, checkResult) {
    if (checkResult) {
      reply.header('RateLimit-Limit', checkResult.limit);
      reply.header('RateLimit-Remaining', checkResult.remaining);
      reply.header('RateLimit-Reset', checkResult.resetAt);
      if (!checkResult.allowed) {
        reply.header(
          'Retry-After',
          Math.max(1, checkResult.resetAt - Math.floor(Date.now() / 1000)),
        );
        return reply.code(429).send({
          isValid: false,
          invalidReason: 'rate_limited',
          invalidMessage: checkResult.reason,
          reason: checkResult.reason,
        });
      }
    }
    return null;
  }

  /**
   * Prefer the limiter state returned by a record call (which reflects the
   * current request already being counted) for the RateLimit-* headers, falling
   * back to the pre-record check if a limiter library does not return state.
   */
  function applyRateLimitHead(reply, recorded, check) {
    if (recorded && Number.isFinite(recorded.remaining)) return handleRateLimit(reply, recorded);
    return handleRateLimit(reply, check);
  }

  /**
   * Both /verify and /settle take {paymentPayload, paymentRequirements}.
   * Returning a non-null reason on a malformed body matters as much as on a
   * failed verification — a null reason anywhere is an acceptance failure.
   *
   * Two validation layers, one shaping:
   *   - AJV (via attachValidation) rejects structural impossibilities before
   *     handler code runs; request.validation carries the errors here.
   *   - request-validation.js adds what a static schema cannot know — whether
   *     the named network is one this instance actually serves — with its own
   *     distinct reason code.
   * Either way the rejection is shaped into the response the calling route
   * would otherwise have sent.
   */
  function readPaymentBody(req, reply, route = 'verify') {
    let result;
    if (req.validationError) {
      const detail = Array.isArray(req.validationError.validation)
        ? req.validationError.validation[0]
        : undefined;
      result = {
        valid: false,
        reason: 'invalid_request',
        message: detail?.message
          ? `${detail.instancePath ?? detail.params?.missingProperty ?? 'body'} ${detail.message}`.trim()
          : (req.validationError.message ?? 'invalid request body'),
      };
    } else {
      result = validatePaymentBody(req.body, config);
    }

    if (!result.valid) {
      if (route === 'settle') {
        reply.code(400).send({
          success: false,
          errorReason: result.reason,
          errorMessage: result.message,
          transaction: '',
          network: req.body?.paymentRequirements?.network,
        });
      } else {
        reply.code(400).send({
          isValid: false,
          invalidReason: result.reason,
          invalidMessage: result.message,
        });
      }
      return null;
    }
    return {
      paymentPayload: result.paymentPayload,
      paymentRequirements: result.paymentRequirements,
    };
  }

  /**
   * Body reader for the manual catalog write (POST /discovery/resources).
   *
   * Same two validation layers as readPaymentBody — AJV shape first, then the
   * network allowlist from request-validation.js — but a deliberately different
   * rejection shape: this is a catalog operation, not a payment, so a failure is
   * `{error, reason}` and carries no isValid/success field to confuse a client
   * that is already handling the payment routes.
   *
   * @returns {{paymentPayload: object, paymentRequirements: object}|null} the
   *   validated body, or null once the 400 response has been sent
   */
  function readDiscoveryBody(req, reply) {
    let result;
    if (req.validationError) {
      const detail = Array.isArray(req.validationError.validation)
        ? req.validationError.validation[0]
        : undefined;
      result = {
        valid: false,
        reason: 'invalid_request',
        message: detail?.message
          ? `${detail.instancePath ?? detail.params?.missingProperty ?? 'body'} ${detail.message}`.trim()
          : (req.validationError.message ?? 'invalid request body'),
      };
    } else {
      result = validatePaymentFields(req.body);
    }

    if (!result.valid) {
      reply.code(400).send({
        error: 'invalid_resource',
        reason: result.reason,
      });
      return null;
    }
    return {
      paymentPayload: result.paymentPayload,
      paymentRequirements: result.paymentRequirements,
    };
  }

  /**
   * GET /healthz — liveness, and the one probe that never fails.
   *
   * It answers as long as the event loop is serving requests, which is exactly
   * what an orchestrator needs to decide "restart this container" (see the
   * Dockerfile HEALTHCHECK): a dependency outage must not be reported here, or a
   * restart loop would make someone else's RPC outage worse. Dependency state
   * belongs on /readyz below.
   */
  app.get('/healthz', async () => ({ ok: true }));

  /**
   * GET /readyz — the readiness probe (#100, #8).
   *
   * Unlike /healthz this CAN fail: 503 names which check failed for which
   * network. Result is cached and bounded by its own timeout — see
   * src/readiness.js. Catalogue trouble is reported but never fails readiness:
   * a cataloguing failure must never fail a payment.
   */
  app.get('/readyz', async (_req, reply) => {
    if (!readiness) {
      const response = {
        ok: false,
        status: 'not_ready',
        reason: 'readiness_not_configured',
      };
      if (failoverHealth) {
        response.failover = failoverHealth.getState();
      }
      return reply.code(503).send(response);
    }
    try {
      const report = await readiness.check();
      if (failoverHealth) {
        report.failover = failoverHealth.getState();
      }
      return reply.code(report.ok ? 200 : 503).send(report);
    } catch (err) {
      return reply.code(503).send({ ok: false, status: 'not_ready', error: err.message });
    }
  });

  /**
   * GET /supported
   *
   * Must emit the Stellar `extra` block including areFeesSponsored — an explicit
   * acceptance item. getSupported() assembles it from the registered schemes, so
   * it is passed through rather than hand-built.
   */
  app.get('/supported', { onRequest: cors('public') }, async () => facilitator.getSupported());

  /**
   * GET /usage — the caller's own meter: spend, rate-limit budgets, remaining
   * fee allowance. Read-only and never rate limited (it reads the meter rather
   * than consuming a bucket), but it is the one route that refuses open mode
   * (requireApiKeyStrict) because an unmetered caller has no meter to read.
   */
  app.get('/usage', { preHandler: requireApiKeyStrict }, async req => {
    annotateSpan({ 'tenant.id': req.keyId ?? 'open', 'http.route': '/usage' });
    return rateLimiter.getUsage(req.keyId);
  });

  /**
   * GET /metrics — Prometheus exposition format (unauthenticated).
   *
   * Served on this listener only when METRICS_PORT is unset; server.js otherwise
   * runs it on a separate, unauthenticated port so it is never on the public
   * surface. The content type carries the Prometheus version marker so scrapers
   * accept it without probing.
   */
  if (serveMetrics) {
    app.get('/metrics', async (_req, reply) => {
      reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return reply.send(metrics.render() + signerMetrics.toPrometheusText());
    });
  }

  /**
   * POST /verify — check a payment payload against its requirements without
   * moving funds.
   *
   * The ordering is load-bearing, not incidental:
   *   1. the rate-limit check runs before the body is even shaped, so the
   *      cheapest rejection wins and a flooding caller cannot make us parse;
   *   2. the body goes through both validation layers (see readPaymentBody);
   *   3. the scheme call races a request timeout, so a stalled Horizon cannot
   *      hold a worker open indefinitely;
   *   4. the outcome is answered 200 with `isValid: false` rather than an HTTP
   *      error — to an agent a 5xx is indistinguishable from the facilitator
   *      being down, whereas a reason code is something it can branch on;
   *   5. only a valid result is catalogued, and that cataloguing happens off the
   *      hot path (a verify proves nothing was paid, so the entry stays
   *      provisional — see processCataloging).
   *
   * An exception escaping the scheme call is mapped onto a reason code and still
   * answered 200 with `isValid: false`, so an upstream failure never becomes
   * indistinguishable from a failure of this transport.
   */
  app.post(
    '/verify',
    {
      onRequest: cors('authenticated'),
      preHandler: requireApiKey,
      schema: { body: PAYMENT_BODY_SCHEMA },
      attachValidation: true,
    },
    async (req, reply) => {
      return withRequestSpan(`HTTP ${req.method} /verify`, req, async () => {
        const check = await rateLimiter.checkVerify(req);
        if (!check.allowed) return rejectRateLimited(req, reply, '/verify', check);

        const body = readPaymentBody(req, reply);
        if (!body) return reply;

        if (req.span) {
          req.span.network = body.paymentRequirements.network;
          req.span.scheme = body.paymentRequirements.scheme;
        }

        try {
          const recorded = await rateLimiter.recordVerify(req);
          applyRateLimitHead(reply, recorded, check);

          const timeoutMs = config.requestTimeoutMs ?? 30_000;
          let timeoutTimer;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => {
              const err = new Error('request timeout');
              err.code = 'REQUEST_TIMEOUT';
              reject(err);
            }, timeoutMs);
          });

          metrics.incActiveVerifications();
          let result;
          try {
            const verifyPromise = tracedSchemeCall(
              'verify',
              body.paymentRequirements.network,
              () => facilitator.verify(body.paymentPayload, body.paymentRequirements),
              { 'tenant.id': req.keyId ?? 'open' },
            );
            result = await Promise.race([verifyPromise, timeoutPromise]).finally(() => {
              clearTimeout(timeoutTimer);
            });
          } finally {
            metrics.decActiveVerifications();
          }

          if (req.span) {
            req.span.outcome = result.isValid ? 'ok' : 'rejected';
            req.span.reason = result.isValid ? 'none' : (result.invalidReason ?? 'invalid');
          }

          audit('verification', {
            actor: req.keyId ?? `ip:${req.ip}`,
            outcome: result.isValid ? 'valid' : 'invalid',
            invalid_reason: result.invalidReason ?? null,
            network: body.paymentRequirements.network,
          });

          if (result.isValid) {
            await processCataloging(req, body, reply, 'verify');
          }

          return reply.send(result);
        } catch (err) {
          const network = body?.paymentRequirements?.network ?? 'unknown';
          const scheme = body?.paymentRequirements?.scheme ?? 'unknown';
          console.error(
            `[/verify] Exception: route=/verify network=${network} scheme=${scheme} ` +
              `error=${err instanceof Error ? err.message : String(err)} ` +
              `stack=${err instanceof Error ? err.stack : 'no stack'}`,
          );

          let invalidReason = 'facilitator_error';
          if (err?.code === 'REQUEST_TIMEOUT') {
            invalidReason = 'request_timeout';
          } else if (err?.code === 'RPC_BREAKER_OPEN') {
            invalidReason = 'soroban_rpc_unreachable';
          } else if (err?.message?.includes('unregistered')) {
            invalidReason = 'unsupported_scheme_network';
          }

          if (req.span) {
            req.span.outcome = 'error';
            req.span.reason = invalidReason;
          }

          if (invalidReason !== 'facilitator_error') {
            audit('rpc_unreachable', {
              actor: req.keyId ?? `ip:${req.ip}`,
              op: 'verify',
              reason: invalidReason,
            });
          }

          return reply.send({
            isValid: false,
            invalidReason,
            invalidMessage: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
  );

  /**
   * POST /settle — settle a verified payment. This is the money-moving route,
   * and the sequence below is part of its contract rather than an
   * implementation detail:
   *
   *   1. the body is validated first (readPaymentBody), then the rate-limit check
   *      runs against the settle bucket — note this is the reverse of /verify,
   *      where the limiter gate is checked before the body is even shaped;
   *   2. the settlement record is consulted next: a repeat of a *settled* key
   *      replays the recorded response, and a *failed* key is only re-attempted
   *      when its error_reason is retryable — a non-retryable failure stays
   *      failed instead of letting a caller burn fees retrying it;
   *   3. the request is recorded as 'submitted' BEFORE the scheme is called, so
   *      a crash mid-flight leaves a traceable record instead of silence;
   *   4. an idempotency-store replay short-circuits the scheme call entirely —
   *      the key is the caller's when supplied and derived from the body
   *      otherwise;
   *   5. a distributed lock serialises concurrent settlement of the same payment
   *      across pods (#116): the lock key is the payment, so unrelated payments
   *      never contend;
   *   6. the scheme call, the terminal state transition and the webhook enqueue
   *      share one transaction where the store supports it (settleAndEnqueue);
   *      where it does not, the event is handed to the dispatcher afterwards;
   *   7. a timeout is reported as `submitted_outcome_unknown` when the request
   *      had already reached the network, and `request_timeout` when it had not,
   *      because only the caller can decide whether to reconcile or retry.
   */
  app.post(
    '/settle',
    {
      onRequest: cors('authenticated'),
      preHandler: requireApiKey,
      schema: { body: PAYMENT_BODY_SCHEMA },
      attachValidation: true,
    },
    async (req, reply) => {
      return withRequestSpan(`HTTP ${req.method} /settle`, req, async () => {
        const body = readPaymentBody(req, reply, 'settle');
        if (!body) return reply;
        const network = body.paymentRequirements.network;
        const signer = signers[network] ?? null;
        if (req.span) {
          req.span.network = network;
          req.span.scheme = body.paymentRequirements.scheme;
        }

        const checkSettle = await rateLimiter.checkSettle(req, network);
        if (!checkSettle.allowed) return rejectRateLimited(req, reply, '/settle', checkSettle);

        const idempotencyKey = settlementStore.deriveIdempotencyKey(req);
        const existingRecord = await settlementStore.get(idempotencyKey);

        if (existingRecord) {
          if (existingRecord.state === 'settled') {
            handleRateLimit(reply, checkSettle);
            if (existingRecord.response) {
              const respPayload =
                typeof existingRecord.response === 'string'
                  ? JSON.parse(existingRecord.response)
                  : existingRecord.response;
              return reply.send(respPayload);
            }
            return reply.send({
              success: true,
              transaction: existingRecord.tx_hash,
              network: existingRecord.network,
              payer: existingRecord.payer,
            });
          }
          if (existingRecord.state === 'submitted' || existingRecord.state === 'unknown') {
            handleRateLimit(reply, checkSettle);
            return reply.send({
              success: false,
              errorReason: 'submitted_outcome_unknown',
              errorMessage:
                existingRecord.error_message || 'settlement in progress or outcome unknown',
              transaction: existingRecord.tx_hash || '',
              network: existingRecord.network,
            });
          }
          if (existingRecord.state === 'failed') {
            const RETRYABLE = new Set([
              'rate_limited',
              'catalog_rate_limited',
              'soroban_rpc_unreachable',
              'lock_timeout',
              'request_timeout',
            ]);
            if (!RETRYABLE.has(existingRecord.error_reason)) {
              handleRateLimit(reply, checkSettle);
              if (existingRecord.response) {
                const respPayload =
                  typeof existingRecord.response === 'string'
                    ? JSON.parse(existingRecord.response)
                    : existingRecord.response;
                return reply.send(respPayload);
              }
              return reply.send({
                success: false,
                errorReason: existingRecord.error_reason,
                errorMessage: existingRecord.error_message,
                transaction: existingRecord.tx_hash || '',
                network: existingRecord.network,
              });
            }
          }
        }

        await settlementStore.save({
          idempotency_key: idempotencyKey,
          network: body.paymentRequirements.network,
          scheme: body.paymentRequirements.scheme,
          payer: body.paymentPayload?.payer ?? null,
          pay_to: body.paymentRequirements.payTo,
          asset: body.paymentRequirements.asset,
          amount: body.paymentRequirements.maxAmountRequired,
          state: 'submitted',
          key_id: req.keyId ?? null,
        });

        /**
         * Exact-once settlement: a repeated idempotency key replays the recorded
         * response instead of touching the chain again. The key is client-supplied
         * when present and derived from the request body otherwise.
         */
        const idemReq = {
          get: name => req.headers[name.toLowerCase()],
          body: req.body,
        };
        const replay = idempotency ? await idempotency.begin(idempotency.keyFor(idemReq)) : null;
        if (replay?.replayed) {
          handleRateLimit(reply, checkSettle);
          return reply.code(replay.statusCode).send(replay.response);
        }
        /**
         * Critical state transition (#116): the settle call moves funds and burns
         * a sequence number, so identical concurrent requests across pod replicas
         * must be serialized before the scheme is invoked. The lock key is the
         * payment itself — two callers racing the same payment contend on the same
         * key; different payments proceed in parallel.
         */
        const lockKey = distributedLock ? lockKeyFor(body.paymentPayload) : null;

        try {
          const settleOnce = async () => {
            if (signer) metrics.setSignerInflight({ network, signer, value: 1 });
            try {
              const result = await tracedSchemeCall(
                'settle',
                body.paymentRequirements.network,
                () => facilitator.settle(body.paymentPayload, body.paymentRequirements),
                { 'tenant.id': req.keyId ?? 'open' },
              );

              const sponsoredFee = result.success
                ? (config.perNetwork?.[network]?.maxTransactionFeeStroops ?? 50000)
                : 0;
              const actualFee = result.success ? result.transactionFeeStroops || 0 : 0;
              const recorded = await rateLimiter.recordSettle(req, sponsoredFee);
              if (req.span) {
                req.span.settleOutcome = result.success ? 'settled' : 'failed';
                req.span.outcome = result.success ? 'ok' : 'rejected';
                req.span.reason = result.success
                  ? 'none'
                  : (result.errorReason ?? 'settlement_failed');
                req.span.txHash = result.transaction || null;
                req.span.feeStroops = actualFee;
              }

              applyRateLimitHead(reply, recorded, checkSettle);

              if (result.success) {
                const event = webhooks
                  ? {
                      type: 'settlement.completed',
                      transaction: result.transaction,
                      network: result.network,
                      payer: result.payer,
                      payTo: body.paymentRequirements.payTo,
                      amount: body.paymentRequirements.maxAmountRequired,
                      asset: body.paymentRequirements.asset,
                    }
                  : null;

                const enqueued = await settlementStore.settleAndEnqueue(
                  idempotencyKey,
                  { tx_hash: result.transaction, response: result },
                  event,
                );

                await processCataloging(req, body, reply, 'settle');

                if (
                  !enqueued.atomicallyEnqueued &&
                  enqueued.event &&
                  webhooks &&
                  typeof webhooks.enqueue === 'function'
                ) {
                  webhooks.enqueue(enqueued.event);
                }

                if (idempotency && replay) {
                  await idempotency.complete(replay.key, 200, result);
                }

                audit('settlement', {
                  actor: req.keyId ?? `ip:${req.ip}`,
                  outcome: result.success ? 'settled' : 'failed',
                  transaction: result.transaction || null,
                  network: result.network ?? body.paymentRequirements.network,
                  fee_stroops: actualFee,
                  error_reason: result.errorReason ?? null,
                });
                return result;
              }

              await settlementStore.updateState(idempotencyKey, 'failed', {
                tx_hash: result.transaction || null,
                error_reason: result.errorReason || 'facilitator_error',
                error_message: result.errorMessage || null,
                response: result,
              });

              if (idempotency && replay) {
                await idempotency.complete(replay.key, 200, result);
              }

              audit('settlement', {
                actor: req.keyId ?? `ip:${req.ip}`,
                outcome: result.success ? 'settled' : 'failed',
                transaction: result.transaction || null,
                network: result.network ?? body.paymentRequirements.network,
                fee_stroops: actualFee,
                error_reason: result.errorReason ?? null,
              });
              return result;
            } finally {
              if (signer) metrics.setSignerInflight({ network, signer, value: 0 });
            }
          };
          const timeoutMs = config.requestTimeoutMs ?? 30_000;
          let timeoutTimer;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => {
              const isSubmitted = requestState.getStore()?.submitted === true;
              const err = new Error(
                isSubmitted
                  ? 'settlement submitted to network but timed out waiting for confirmation'
                  : 'request timeout',
              );
              err.code = isSubmitted ? 'SUBMITTED_OUTCOME_UNKNOWN' : 'REQUEST_TIMEOUT';
              reject(err);
            }, timeoutMs);
          });

          const resultPromise = distributedLock
            ? distributedLock.withLock(lockKey, settleOnce)
            : settleOnce();

          const result = await Promise.race([resultPromise, timeoutPromise]).finally(() => {
            clearTimeout(timeoutTimer);
          });
          return reply.send(result);
        } catch (err) {
          // SettleResponse requires `transaction` and `network` even on failure, so
          // a client can attribute the failure without correlating out of band.
          //
          // A lock that never freed under healthy Redis gets its own code (#116),
          // and an open RPC breaker gets its own code so a caller can tell "the
          // chain is unreachable" from "your payment was rejected" (#105, #6).
          const network = body?.paymentRequirements?.network ?? 'unknown';
          const scheme = body?.paymentRequirements?.scheme ?? 'unknown';
          console.error(
            `[/settle] Exception: route=/settle network=${network} scheme=${scheme} ` +
              `error=${err instanceof Error ? err.message : String(err)} ` +
              `stack=${err instanceof Error ? err.stack : 'no stack'}`,
          );

          let errorReason = 'facilitator_error';
          if (err?.code === 'SUBMITTED_OUTCOME_UNKNOWN') {
            errorReason = 'submitted_outcome_unknown';
          } else if (err?.code === 'REQUEST_TIMEOUT') {
            // A timeout after the scheme was actually submitted leaves the outcome
            // unknown on our side: report it distinctly so a caller can reconcile
            // out of band (#8).
            errorReason =
              requestState.getStore()?.submitted === true
                ? 'submitted_outcome_unknown'
                : 'request_timeout';
          } else if (err instanceof Error && err.name === 'LockAcquireTimeoutError') {
            errorReason = 'lock_timeout';
          } else if (err?.code === 'RPC_BREAKER_OPEN') {
            errorReason = 'soroban_rpc_unreachable';
            audit('rpc_unreachable', { actor: req.keyId ?? `ip:${req.ip}`, op: 'settle' });
          } else if (err?.message?.includes('unregistered')) {
            errorReason = 'unsupported_scheme_network';
          }
          if (req.span) {
            req.span.outcome = 'error';
            req.span.reason = errorReason;
            req.span.settleOutcome = 'failed';
          }

          let transaction = '';
          if (
            body.paymentPayload?.transaction &&
            typeof body.paymentPayload.transaction === 'string'
          ) {
            transaction = body.paymentPayload.transaction;
          }
          const targetState = errorReason === 'submitted_outcome_unknown' ? 'unknown' : 'failed';
          await settlementStore.updateState(idempotencyKey, targetState, {
            tx_hash: transaction,
            error_reason: errorReason,
            error_message: err instanceof Error ? err.message : String(err),
          });
          return reply.send({
            success: false,
            errorReason,
            errorMessage: err instanceof Error ? err.message : String(err),
            transaction,
            network: req.body?.paymentRequirements?.network ?? '',
          });
        }
      });
    },
  );

  /**
   * GET /settlements/:idempotencyKey — Settlement status read API (#10).
   * Scoped to the authenticated caller's keyId.
   */
  app.get(
    '/settlements/:idempotencyKey',
    {
      onRequest: cors('authenticated'),
      preHandler: requireApiKey,
    },
    async (req, reply) => {
      const { idempotencyKey } = req.params;
      // Read-after-write consistency (#121): this is the status read that
      // follows a fresh settle. `getConsistent` serves this process's own
      // writes from memory and tolerates replication lag against the replica
      // before confirming a miss on the primary, so "settle then immediately
      // GET" never returns a transient 404.
      const record =
        typeof settlementStore.getConsistent === 'function'
          ? await settlementStore.getConsistent(idempotencyKey)
          : await settlementStore.get(idempotencyKey);
      if (!record) {
        return reply.code(404).send({ error: 'not_found', message: 'Settlement record not found' });
      }

      // Key ids are case-insensitive by design (normalized to uppercase at
      // auth, see requireApiKey), so compare against the normalized form.
      if (req.keyId && record.key_id && record.key_id.toUpperCase() !== req.keyId) {
        return reply.code(404).send({ error: 'not_found', message: 'Settlement record not found' });
      }

      return reply.send({ ok: true, settlement: record });
    },
  );

  /**
   * GET /settlements/:idempotencyKey/events — full, ordered event history for
   * one settlement (#130). The projection above answers "what is the current
   * state"; this answers "how did it get there" — the record a regulatory
   * audit needs. Scoped identically to the settlement it belongs to.
   */
  app.get(
    '/settlements/:idempotencyKey/events',
    {
      onRequest: cors('authenticated'),
      preHandler: requireApiKey,
    },
    async (req, reply) => {
      const { idempotencyKey } = req.params;
      const record = await settlementStore.get(idempotencyKey);
      if (!record) {
        return reply.code(404).send({ error: 'not_found', message: 'Settlement record not found' });
      }

      // Key ids are case-insensitive by design (normalized to uppercase at
      // auth, see requireApiKey), so compare against the normalized form.
      if (req.keyId && record.key_id && record.key_id.toUpperCase() !== req.keyId) {
        return reply.code(404).send({ error: 'not_found', message: 'Settlement record not found' });
      }

      const events = await settlementStore.getEventLog(idempotencyKey);
      return reply.send({ ok: true, idempotencyKey, events });
    },
  );

  /**
   * Manual registration, the secondary path.
   *
   * Automatic cataloging off the payment path is the primary one — anything
   * that requires a seller to act after being paid gets skipped.
   */
  app.post(
    '/discovery/resources',
    {
      onRequest: cors('authenticated'),
      preHandler: requireApiKey,
      schema: { body: PAYMENT_BODY_SCHEMA },
      attachValidation: true,
    },
    async (req, reply) => {
      const body = readDiscoveryBody(req, reply);
      if (!body) return reply;

      const checkCatalog = await rateLimiter.checkCatalog(req);
      if (!checkCatalog.allowed)
        return rejectRateLimited(req, reply, '/discovery/resources', checkCatalog);

      const validation = validateForCatalog(body.paymentPayload, body.paymentRequirements);
      if (validation.hardDrop) {
        return reply.code(400).send({ error: 'invalid_resource', reason: validation.reason });
      }

      await rateLimiter.recordCatalog(req);
      try {
        const existing = await catalog.getResource?.(
          validation.resource.url,
          validation.resource.toolName ?? null,
        );
        const entry = await catalog.upsertResource(validation.resource, 'manual');
        audit('catalog_write', {
          actor: req.keyId ?? `ip:${req.ip}`,
          source: 'manual',
          url: validation.resource.url,
          tool_name: validation.resource.toolName ?? null,
          overwritten: Boolean(existing),
        });
        return reply.send({ ok: true, resource: entry, softDrops: validation.softDrops });
      } catch (err) {
        console.error(`[Catalog] manual upsert error: ${err.message}`);
        const code = err && err.code ? err.code : 'catalog_error';
        return reply.code(400).send({ error: 'catalog_error', reason: code });
      }
    },
  );

  /**
   * Discovery caching (#200).
   *
   * GET /discovery/resources and /discovery/search are the read-heavy half of
   * the service and the half most likely to be polled, yet they carried no
   * cache headers — so every agent query re-ran the ranking/embedding path over
   * data the client already held. Both routes now emit:
   *
   *   - Cache-Control: configurable `public, max-age=…, stale-while-revalidate=…`
   *   - a weak ETag derived from BOTH the monotonic catalog version (any write
   *     changes it) AND the full query-parameter set (different filters get
   *     different validators, so a cache can never satisfy one filter with
   *     another's body), and
   *   - Last-Modified (from the catalog store's write timestamp) when available.
   *
   * If-None-Match is honoured with an empty 304 BEFORE the expensive work runs,
   * so a polling client that already holds the data never re-embeds the query
   * or re-scores the catalog.
   */
  function applyDiscoveryCache(req, reply, catalog, params) {
    const policy = config.discoveryCache ?? { maxAgeSeconds: 60, staleWhileRevalidateSeconds: 300 };
    const cc = `public, max-age=${policy.maxAgeSeconds}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`;
    reply.header('cache-control', cc);

    const version = typeof catalog.getVersion === 'function' ? catalog.getVersion() : 0;
    const etag = discoveryETag(version, params);
    reply.header('etag', etag);

    if (typeof catalog.getLastModified === 'function') {
      const lm = catalog.getLastModified();
      if (lm) reply.header('last-modified', new Date(lm).toUTCString());
    }

    const inm = req.headers['if-none-match'];
    const notModified = inm
      ? inm
          .split(',')
          .map(s => s.trim())
          .includes(etag)
      : false;
    return { etag, notModified };
  }

  /**
   * GET /discovery/resources — public catalog read.
   *
   * Public reads are intentional: a discovery catalog that agents cannot browse
   * is not much of a catalog. The endpoint is unauthenticated but rate-limited
   * to prevent abuse. Reads use a separate bucket from writes (catalogReadRpm)
   * because they have very different cost profiles.
   *
   * Pagination is clamped at the API boundary before passing to the catalog.
   * The catalog may assume validated input; duplicated defensive clamping in
   * the catalog implementation is acceptable if documented.
   */
  app.get('/discovery/resources', { onRequest: cors('public') }, async (req, reply) => {
    annotateSpan({ 'tenant.id': req.keyId ?? 'open', 'http.route': '/discovery/resources' });
    const checkCatalogRead = await rateLimiter.checkCatalogRead(req);
    if (!checkCatalogRead.allowed)
      return rejectRateLimited(req, reply, '/discovery/resources', checkCatalogRead);

    let extensions;
    if (req.query.extensions) {
      extensions = Array.isArray(req.query.extensions)
        ? req.query.extensions
        : req.query.extensions.split(',');
    }

    // Clamp pagination at the boundary before calling catalog
    let parsedLimit = parseInt(req.query.limit, 10);
    if (isNaN(parsedLimit)) parsedLimit = 20;
    const clampedLimit = Math.min(Math.max(1, parsedLimit), 100);

    let parsedOffset = parseInt(req.query.offset, 10);
    if (isNaN(parsedOffset)) parsedOffset = 0;
    const clampedOffset = Math.max(0, parsedOffset);

    const params = {
      type: req.query.type,
      payTo: req.query.payTo,
      scheme: req.query.scheme,
      network: req.query.network,
      extensions,
      limit: clampedLimit,
      offset: clampedOffset,
    };

    // #200: validators are computed and matched BEFORE the expensive work, so
    // a polling client that already holds this representation gets an empty
    // 304 instead of a re-run of the listing path.
    const cache = applyDiscoveryCache(req, reply, catalog, params);
    if (cache.notModified) return reply.code(304).send();

    try {
      const result = await catalog.listResources(params);
      await rateLimiter.recordCatalogRead(req);
      handleRateLimit(reply, checkCatalogRead);

      return reply.send({
        x402Version: 2,
        items: result.items,
        pagination: {
          limit: clampedLimit,
          offset: clampedOffset,
          total: result.total,
        },
      });
    } catch (err) {
      console.error(`[Discovery] listResources error: ${err.message}`);
      return reply.code(500).send({ error: 'internal_error', reason: 'internal_error' });
    }
  });

  /**
   * GET /discovery/search — public catalog search.
   *
   * Public search is intentional for the same reason as listResources. This
   * endpoint is more expensive than listResources (it delegates to embeddings.js),
   * so it shares the catalog_read bucket but is weighted accordingly in config.
   *
   * Pagination is clamped at the API boundary before passing to the catalog.
   */
  app.get('/discovery/search', { onRequest: cors('public') }, async (req, reply) => {
    annotateSpan({ 'tenant.id': req.keyId ?? 'open', 'http.route': '/discovery/search' });
    const checkCatalogRead = await rateLimiter.checkCatalogRead(req);
    if (!checkCatalogRead.allowed)
      return rejectRateLimited(req, reply, '/discovery/search', checkCatalogRead);

    if (!req.query.query) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'query is required' });
    }

    let extensions;
    if (req.query.extensions) {
      extensions = Array.isArray(req.query.extensions)
        ? req.query.extensions
        : req.query.extensions.split(',');
    }

    // Clamp pagination at the boundary before calling catalog
    let parsedLimit = parseInt(req.query.limit, 10);
    if (isNaN(parsedLimit)) parsedLimit = 20;
    const clampedLimit = Math.min(Math.max(1, parsedLimit), 100);

    const params = {
      query: req.query.query,
      type: req.query.type,
      payTo: req.query.payTo,
      scheme: req.query.scheme,
      network: req.query.network,
      extensions,
      limit: clampedLimit,
      cursor: req.query.cursor,
    };

    // #200: same contract as the listing route — validators before the
    // expensive work (here: embedding the query and scoring the catalog).
    const cache = applyDiscoveryCache(req, reply, catalog, params);
    if (cache.notModified) return reply.code(304).send();

    try {
      const result = await catalog.search(params);
      await rateLimiter.recordCatalogRead(req);
      handleRateLimit(reply, checkCatalogRead);

      return reply.send({
        x402Version: 2,
        resources: result.resources,
        partialResults: result.partialResults,
        pagination: result.pagination,
      });
    } catch (err) {
      console.error(`[Discovery] search error: ${err.message}`);
      return reply.code(500).send({ error: 'internal_error', reason: 'internal_error' });
    }
  });

  /**
   * DLQ operator API (view/replay/discard poisoned webhook messages).
   * Registered only when a DeadLetterStore is available (DATABASE_URL set).
   */
  if (dlq) {
    registerDlqRoutes(app, {
      dlq: dlq.store,
      publish: dlq.publish,
      requireApiKeyStrict,
      cors,
      preflight,
      audit,
      retryOptions: dlq.retryOptions,
    });
  }

  /**
   * Preflight routes (#76).
   *
   * Each CORS-enabled path gets an explicit OPTIONS handler. It sees the
   * OPTIONS method and replies 204 — carrying ACAO only when the origin is
   * granted — and carries no auth hook, because a preflight cannot carry the
   * API key.
   */
  app.options('/supported', { onRequest: cors('public') }, preflight('public'));
  app.options('/discovery/search', { onRequest: cors('public') }, preflight('public'));
  app.options(
    '/discovery/resources',
    { onRequest: cors('authenticated') },
    preflight('authenticated'),
  );
  app.options('/verify', { onRequest: cors('authenticated') }, preflight('authenticated'));
  app.options('/settle', { onRequest: cors('authenticated') }, preflight('authenticated'));

  /**
   * 404 (#78). Every rejection carries a non-null reason code, transport-level
   * ones included — an unknown route is no exception.
   */
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not_found', reason: 'route_not_found' });
  });

  /**
   * The one error boundary (#78), registered last so both thrown errors and
   * rejected promises from async handlers reach it. The route-level catch
   * blocks above are left alone: they encode deliberate decisions (/verify
   * answers 200 with isValid: false rather than a 500, because to a client a
   * 500 is indistinguishable from the service being down); this boundary only
   * catches what escapes them — plus the two body-parser failures Fastify
   * raises before any handler runs (malformed JSON, oversized body).
   *
   * The response shape is matched to the route, not flattened into a generic
   * {error} — /verify failures look like verification failures, /settle
   * failures carry transaction and network so a client can attribute the
   * failure without correlating out of band.
   *
   * Stack traces go to the server log only, never the wire, and that is not
   * gated on NODE_ENV — which is unset in the Docker image.
   */
  app.setErrorHandler((err, req, reply) => {
    console.error(`[Error] ${err?.type ?? err?.code ?? err?.name ?? 'Error'}: ${err?.message}`);

    let status = err?.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    let code = 'internal_error';

    // Fastify's content-parser errors, mapped onto the reason codes the
    // Express transport used to emit for entity.parse.failed / entity.too.large.
    // Fastify 5 names the malformed-JSON error `FST_ERR_CTP_INVALID_JSON_BODY`
    // (the pre-v5 `FST_ERR_CTP_INVALID_JSON` is matched too for back-compat so
    // a future downgrade cannot silently regress the wire code to
    // `internal_error`).
    if (err?.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err?.code === 'FST_ERR_CTP_INVALID_JSON') {
      status = 400;
      code = 'malformed_json';
    } else if (err?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      status = 413;
      code = 'payload_too_large';
    }

    const path = req.routeOptions?.url ?? req.raw.url?.split('?')[0];

    if (path === '/verify') {
      return reply.code(status).send({
        isValid: false,
        invalidReason: code,
        invalidMessage: err instanceof Error ? err.message : String(err),
      });
    }
    if (path === '/settle') {
      return reply.code(status).send({
        success: false,
        errorReason: code,
        errorMessage: err instanceof Error ? err.message : String(err),
        transaction: '',
        network: req.body?.paymentRequirements?.network,
      });
    }
    return reply.code(status).send({ error: code, reason: code });
  });

  return app;
}
