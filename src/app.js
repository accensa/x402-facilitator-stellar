/**
 * The HTTP surface: /verify, /settle, /supported, /usage, /discovery/resources,
 * /healthz, /health/ready.
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
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { validateForCatalog } from './catalog/validation.js';
import { createAuditLogger } from './audit.js';
import { createReadinessChecker } from './readiness.js';
import { validatePaymentBody, validatePaymentFields } from './request-validation.js';
import { createRequestLog } from './log.js';
import { createMetrics } from './metrics.js';

import { lockKeyFor } from './distributed-lock.js';
import { requestState } from './request-state.js';
import { signerMetrics } from './metrics.js';
import { buildSettlementStore } from './store/index.js';

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
 * Builds the Fastify app.
 *
 * Takes its collaborators rather than reaching for module state, which is what
 * makes the surface testable: a test can supply a facilitator that throws, a
 * rate limiter already at its ceiling, or a catalog that rejects a write,
 * without a network, a keypair or a subprocess.
 *
 * `signers` is deliberately not a parameter — no route reads it. The addresses
 * reach the wire through facilitator.getSupported(); server.js keeps them only
 * to print the boot banner.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @param {{verify: Function, settle: Function, getSupported: Function}} facilitator
 * @param {object} rateLimiter - RateLimiter, or a stub with the same surface
 * @param {{upsertResource: Function, listResources: Function}} catalog
 * @param {{keyFor: Function, begin: Function, complete: Function}} [idempotency]
 *   optional idempotency store for /settle; absent means in-memory only
 * @param {object} [extras] - optional collaborators:
 *   - distributedLock (#116): Redlock-backed lock for state transitions
 *   - webhooks (#117): asynchronous webhook dispatcher
 *   - audit: audit writer override (default createAuditLogger)
 *   - readiness: readiness checker override
 *   - breakerStates: breaker-state reader for the readiness probe (#105)
 *   - failoverHealth (#126): region-aware failover health checker
 * @returns {import('fastify').FastifyInstance}
 */
export function createApp(config, facilitator, rateLimiter, catalog, idempotency, extras = {}) {
  const {
    distributedLock = null,
    webhooks = null,
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
   * In-flight request tracking for graceful shutdown (#248) combined with
   * request correlation + structured logging (#7).
   */
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
   * Operational endpoints (/metrics, /healthz, /health/ready) are logged but
   * excluded from x402_requests_total so the payment-request counters stay
   * semantically about payments.
   */
  const OPERATIONAL_ROUTES = new Set(['/metrics', '/healthz', '/health/ready']);
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
      Object.defineProperty(req, 'ip', { value: ip });
    });
  }

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
   */
  async function processCataloging(req, body, reply, source = 'payment') {
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
          console.warn(`[Catalog] Rate limit exceeded for IP ${req.ip}`);
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
      console.error('[Catalog] Unhandled error during processCataloging:', err);
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
   * Require API key for usage (no open mode allowed for this).
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

  /** Rate-limit rejections are auditable: they are abuse signals, not noise. */
  function rejectRateLimited(req, reply, route, checkResult, extra = {}) {
    audit('rate_limit_rejected', {
      actor: req.keyId ?? `ip:${req.ip}`,
      route,
      reason: checkResult.reason,
      ...extra,
    });
    return handleRateLimit(reply, checkResult);
  }

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

  app.get('/usage', { preHandler: requireApiKeyStrict }, async req =>
    rateLimiter.getUsage(req.keyId),
  );

  app.post(
    '/verify',
    {
      onRequest: cors('authenticated'),
      preHandler: requireApiKey,
      schema: { body: PAYMENT_BODY_SCHEMA },
      attachValidation: true,
    },
    async (req, reply) => {
      const check = await rateLimiter.checkVerify(req);
      if (!check.allowed) return rejectRateLimited(req, reply, '/verify', check);

      const body = readPaymentBody(req, reply);
      if (!body) return reply;
      if (req.span) {
        req.span.network = body.paymentRequirements.network;
        req.span.scheme = body.paymentRequirements.scheme;
      }
      try {
        await rateLimiter.recordVerify(req);
        handleRateLimit(reply, check);
        const timeoutMs = config.requestTimeoutMs ?? 30_000;
        let timeoutTimer;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => {
            const err = new Error('request timeout');
            err.code = 'REQUEST_TIMEOUT';
            reject(err);
          }, timeoutMs);
        });

        const verifyPromise = facilitator.verify(body.paymentPayload, body.paymentRequirements);
        const result = await Promise.race([verifyPromise, timeoutPromise]).finally(() => {
          clearTimeout(timeoutTimer);
        });

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
          await processCataloging(req, body, reply, 'payment');
        }
        return reply.send(result);
      } catch (err) {
        // An exception must not become a 500 with an empty body: to a client that
        // is indistinguishable from the service being down, and it carries no
        // reason code. Shape it like a verification failure instead.
        //
        // Note ExactStellarScheme already absorbs its own internal exceptions and
        // returns invalidReason "unexpected_verify_error" rather than throwing, so
        // this path only catches failures above the scheme — an unregistered
        // scheme/network pair, for instance. A distinct code keeps the two
        // distinguishable to a client.
        //
        // An open RPC breaker gets its own code so a caller can tell "the chain
        // is unreachable" from "your payment was rejected" (#105, #6).
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
    },
  );

  app.post(
    '/settle',
    {
      onRequest: cors('authenticated'),
      preHandler: requireApiKey,
      schema: { body: PAYMENT_BODY_SCHEMA },
      attachValidation: true,
    },
    async (req, reply) => {
      const body = readPaymentBody(req, reply, 'settle');
      if (!body) return reply;
      const network = body.paymentRequirements.network;
      const signer = signers[network] ?? null;
      if (req.span) {
        req.span.network = network;
        req.span.scheme = body.paymentRequirements.scheme;
      }

      const check = await rateLimiter.checkSettle(req, network);
      if (!check.allowed) return rejectRateLimited(req, reply, '/settle', check);

      const idempotencyKey = settlementStore.deriveIdempotencyKey(req);
      const existingRecord = await settlementStore.get(idempotencyKey);

      if (existingRecord) {
        if (existingRecord.state === 'settled') {
          handleRateLimit(reply, check);
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
          handleRateLimit(reply, check);
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
            handleRateLimit(reply, check);
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
        handleRateLimit(reply, check);
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
          // Sequence-contention signal (#9): this signer is now mid-settlement.
          if (signer) metrics.setSignerInflight({ network, signer, value: 1 });
          try {
            const result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
            // The fee ceiling (feeSpd) is reserved against the sponsored max, so
            // the rate limiter is told the worst-case fee per settlement.
            const sponsoredFee = result.success
              ? (config.perNetwork?.[network]?.maxTransactionFeeStroops ?? 50000)
              : 0;
            // The metrics/audit record the fee actually paid by this settlement.
            const actualFee = result.success ? result.transactionFeeStroops || 0 : 0;
            await rateLimiter.recordSettle(req, sponsoredFee);
            if (req.span) {
              req.span.settleOutcome = result.success ? 'settled' : 'failed';
              req.span.outcome = result.success ? 'ok' : 'rejected';
              req.span.reason = result.success
                ? 'none'
                : (result.errorReason ?? 'settlement_failed');
              req.span.txHash = result.transaction || null;
              req.span.feeStroops = actualFee;
            }
            handleRateLimit(reply, check);
            if (result.success) {
              // Settlement notification (#123): the event is written to the
              // outbox in the SAME database transaction as the 'settled' state
              // change, so a crash between settling and notifying cannot lose
              // the notification — the outbox worker publishes it afterwards.
              // Only when no durable outbox exists (in-memory store or degraded
              // Postgres) do we fall back to the fire-and-forget webhook
              // publish (#117), which is the pre-outbox behaviour.
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

              await processCataloging(req, body, reply, 'payment');

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

              // Settlements are THE auditable record: which authenticated caller moved
              // money, and the transaction hash to reconstruct it by.
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

            // Failure path: record the rejected settlement so a later repeat is
            // not retried (unless the reason is in the retryable set, handled
            // upstream when reading the existing record).
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
            const err = new Error('request timeout');
            err.code = 'REQUEST_TIMEOUT';
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
        let errorReason = 'facilitator_error';
        if (err?.code === 'REQUEST_TIMEOUT') {
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

      const check = await rateLimiter.checkCatalog(req);
      if (!check.allowed) return rejectRateLimited(req, reply, '/discovery/resources', check);

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
        return reply.code(400).send({ error: 'catalog_error', reason: 'catalog_error' });
      }
    },
  );

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
    const check = await rateLimiter.checkCatalogRead(req);
    if (!check.allowed) return rejectRateLimited(req, reply, '/discovery/resources', check);

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

    try {
      const result = await catalog.listResources(params);
      await rateLimiter.recordCatalogRead(req);
      handleRateLimit(reply, check);

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
    const check = await rateLimiter.checkCatalogRead(req);
    if (!check.allowed) return rejectRateLimited(req, reply, '/discovery/search', check);

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

    try {
      const result = await catalog.search(params);
      await rateLimiter.recordCatalogRead(req);
      handleRateLimit(reply, check);

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
    if (err?.code === 'FST_ERR_CTP_INVALID_JSON') {
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
