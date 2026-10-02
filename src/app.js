import Fastify from 'fastify';
import compress from '@fastify/compress';
import { validateForCatalog } from './catalog/validation.js';
import { createAuditLogger } from './audit.js';
import { createReadinessChecker } from './readiness.js';
import { createRequestLog } from './log.js';
import { createMetrics, signerMetrics } from './metrics.js';
import { createIpPseudonymizer } from './ip.js';
import { createTrustProxyHook } from './trust-proxy.js';
import { lockKeyFor } from './distributed-lock.js';
import { requestState } from './request-state.js';
import { buildSettlementStore } from './store/index.js';
import { registerDlqRoutes } from './dlq/routes.js';
import { annotateSpan, withRequestSpan, tracedSchemeCall } from './tracing.js';
import { createCorsHook, createPreflightHandler } from './cors.js';
import { createAuthMiddleware } from './auth.js';
import { handleRateLimit, rejectRateLimited } from './rate-limit-http.js';
import { applyDiscoveryCache } from './catalog/discovery-cache.js';
import {
  BODY_LIMIT_BYTES,
  PAYMENT_BODY_SCHEMA,
  readPaymentBody,
  readDiscoveryBody,
} from './payment-body.js';

/**
 * Meaningful message extraction for anything a collaborator throws (#369).
 *
 * `String(err)` turns a thrown object into '[object Object]', which tells a
 * client nothing. Errors keep their message (they are already meaningful);
 * every other value is JSON-stringified so the caller still receives the
 * content, and a value JSON cannot represent falls back to String().
 *
 * @param {unknown} err - the thrown value
 * @returns {string} a message that always carries the error's content
 */
function describeThrown(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Builds the Fastify app.
 *
 * Takes its collaborators rather than reaching for module state, which is what
 * makes the surface testable: a test can supply a facilitator that throws, a
 * rate limiter already at its ceiling, or a catalog that rejects a write,
 * without a network, a keypair or a subprocess.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @param {{verify: Function, settle: Function, getSupported: Function}} facilitator
 * @param {object} rateLimiter - RateLimiter, or a stub with the same surface
 * @param {{upsertResource: Function, listResources: Function, search?: Function, getResource?: Function, getVersion?: Function, getLastModified?: Function}} catalog
 * @param {{keyFor: Function, begin: Function, complete: Function}} [idempotency]
 * @param {object} [extras] - optional collaborators
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

  // Observability collaborators.
  const logger = extras.logger ?? createRequestLog({ level: config.logLevel ?? 'info' });
  const metrics = extras.metrics ?? createMetrics();
  const signers = extras.signers ?? {};
  const ipPseudonymizer = extras.ipPseudonymizer ?? createIpPseudonymizer();

  // Seed the signer-inflight series at zero for every configured signer.
  for (const [network, signer] of Object.entries(signers)) {
    if (signer) metrics.setSignerInflight({ network, signer, value: 0 });
  }

  const serveMetrics = extras.serveMetrics !== false;

  // #392: the catalog search cache is an optional decorator around the store,
  // so the metrics registry is attached here — app.js owns the registry, and
  // server.js (which builds the cache) does not. No-ops on a plain store.
  if (typeof catalog?.searchCache?.onLookup !== 'undefined') {
    catalog.searchCache.onLookup = lookup => metrics.incCatalogCacheLookup(lookup);
  }

  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: false,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        allErrors: true,
      },
    },
  });

  await app.register(compress);

  let activeRequestCount = 0;
  app.decorate('getInFlightCount', () => activeRequestCount);

  app.addHook('onRequest', (req, reply, done) => {
    activeRequestCount++;
    const span = logger.begin(req);
    req.span = span;
    reply.header('X-Request-Id', span.requestId);
    requestState.run({ submitted: false }, () => {
      done?.();
    });
  });

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

  // Audit records — who did what (settlements, auth failures, catalog writes) —
  // are a different artifact from the request log: every line carries a
  // `channel: "audit"` marker and goes to stdout, plus AUDIT_LOG_FILE when one
  // is configured. See src/audit.js and docs/AUDIT.md.
  const audit = extras.audit ?? createAuditLogger();

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

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (config.nodeEnv === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  // Client-IP resolution behind reverse proxies and CDNs (src/trust-proxy.js)
  // is the single choke point that decides what req.ip may mean. It runs
  // ahead of the pseudonymiser below so every consumer — the rate limiter's
  // bucket key, audit actors — sees the resolved, spoof-resistant address.
  app.addHook('onRequest', createTrustProxyHook(config.trustProxy));

  app.addHook('onRequest', async req => {
    const pseudonym = ipPseudonymizer(req.ip);
    if (pseudonym !== undefined && pseudonym !== req.ip) {
      Object.defineProperty(req, 'ip', { value: pseudonym, configurable: true });
    }
  });

  const cors = createCorsHook(config.cors);
  const preflight = createPreflightHandler(config.cors);
  const { requireApiKey, requireApiKeyStrict } = createAuthMiddleware({ config, audit });

  /**
   * Catalogs a resource declared in a payment, off the hot path (#140, #146).
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
          console.warn('[Catalog] Rate limit exceeded for caller');
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

          Promise.resolve().then(async () => {
            try {
              const existing = await catalog.getResource?.(
                validation.resource.url,
                validation.resource.toolName ?? null,
              );
              await catalog.upsertResource(validation.resource, source);
              // Tell the search cache the catalog moved (#392). The local
              // version bump already makes stale entries unreachable; this
              // publishes so *other* replicas drop their L1 now instead of on
              // their next miss. Best-effort and never on the payment path.
              await catalog.searchCache?.invalidate({ reason: `cataloging:${source}` });
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
        // Encoded lazily (#368): the base64 EXTENSION-RESPONSES value was
        // previously built eagerly on every catalogable verify/settle — a JSON
        // stringify plus a Buffer copy plus the 4/3x base64 expansion — even
        // though most callers never read the header. Computing it from the
        // settled `outcome` only when Fastify serializes the headers keeps the
        // hot path allocation-free for the common case while producing exactly
        // the same bytes for callers that do read it (asserted in app.test.js,
        // 'the lazy EXTENSION-RESPONSES encoding is byte-identical').
        {
          toString() {
            return Buffer.from(JSON.stringify({ bazaar: outcome })).toString('base64');
          },
        },
      );
    } catch (err) {
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

  // ---------------------------------------------------------------------------
  // Core and Operational Routes
  // ---------------------------------------------------------------------------

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

  if (serveMetrics) {
    app.get('/metrics', async (_req, reply) => {
      reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return reply.send(metrics.render() + signerMetrics.toPrometheusText());
    });
  }

  // ---------------------------------------------------------------------------
  // Payment Routes (/verify, /settle)
  // ---------------------------------------------------------------------------

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
        if (!check.allowed) return rejectRateLimited(req, reply, '/verify', check, audit);

        const body = readPaymentBody(req, reply, config, 'verify');
        if (!body) return reply;

        if (req.span) {
          req.span.network = body.paymentRequirements.network;
          req.span.scheme = body.paymentRequirements.scheme;
        }

        try {
          const recorded = await rateLimiter.recordVerify(req);
          const limited = handleRateLimit(reply, recorded, check);
          if (limited) return limited;

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
              `error=${describeThrown(err)} ` +
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
            invalidMessage: describeThrown(err),
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
        const body = readPaymentBody(req, reply, config, 'settle');
        if (!body) return reply;
        const network = body.paymentRequirements.network;
        const signer = signers[network] ?? null;
        if (req.span) {
          req.span.network = network;
          req.span.scheme = body.paymentRequirements.scheme;
        }

        const checkSettle = await rateLimiter.checkSettle(req, network);
        if (!checkSettle.allowed)
          return rejectRateLimited(req, reply, '/settle', checkSettle, audit);

        const idempotencyKey = settlementStore.deriveIdempotencyKey(req);
        const existingRecord = await settlementStore.get(idempotencyKey);

        if (existingRecord) {
          if (existingRecord.state === 'settled') {
            const limited = handleRateLimit(reply, checkSettle);
            if (limited) return limited;
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
            const limited = handleRateLimit(reply, checkSettle);
            if (limited) return limited;
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
              const limited = handleRateLimit(reply, checkSettle);
              if (limited) return limited;
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

        const idemReq = {
          get: name => req.headers[name.toLowerCase()],
          body: req.body,
        };
        const replay = idempotency ? await idempotency.begin(idempotency.keyFor(idemReq)) : null;
        if (replay?.replayed) {
          const limited = handleRateLimit(reply, checkSettle);
          if (limited) return limited;
          return reply.code(replay.statusCode).send(replay.response);
        }

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

              const limited = handleRateLimit(reply, recorded, checkSettle);
              if (limited) return limited;

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

                // These are best-effort side effects on an already-settled,
                // already-persisted transaction (#344): if the webhook enqueue
                // or idempotency write throws, the settlement itself must
                // still be reported as successful to the caller rather than
                // falling into the outer catch, which would otherwise
                // overwrite the durable 'settled' record with 'failed' and
                // tell the caller their payment failed after funds moved.
                if (
                  !enqueued.atomicallyEnqueued &&
                  enqueued.event &&
                  webhooks &&
                  typeof webhooks.enqueue === 'function'
                ) {
                  try {
                    webhooks.enqueue(enqueued.event);
                  } catch (err) {
                    console.error(
                      `[/settle] webhook enqueue failed for ${idempotencyKey}: ${describeThrown(err)}`,
                    );
                  }
                }

                if (idempotency && replay) {
                  try {
                    await idempotency.complete(replay.key, 200, result);
                  } catch (err) {
                    console.error(
                      `[/settle] idempotency.complete failed for ${idempotencyKey}: ${describeThrown(err)}`,
                    );
                  }
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
                try {
                  await idempotency.complete(replay.key, 200, result);
                } catch (err) {
                  console.error(
                    `[/settle] idempotency.complete failed for ${idempotencyKey}: ${describeThrown(err)}`,
                  );
                }
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
          const network = body?.paymentRequirements?.network ?? 'unknown';
          const scheme = body?.paymentRequirements?.scheme ?? 'unknown';
          console.error(
            `[/settle] Exception: route=/settle network=${network} scheme=${scheme} ` +
              `error=${describeThrown(err)} ` +
              `stack=${err instanceof Error ? err.stack : 'no stack'}`,
          );

          let errorReason = 'facilitator_error';
          if (err?.code === 'SUBMITTED_OUTCOME_UNKNOWN') {
            errorReason = 'submitted_outcome_unknown';
          } else if (err?.code === 'REQUEST_TIMEOUT') {
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
            error_message: describeThrown(err),
          });
          return reply.send({
            success: false,
            errorReason,
            errorMessage: describeThrown(err),
            transaction,
            network: req.body?.paymentRequirements?.network ?? '',
          });
        }
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Settlement Status and Audit Read Routes
  // ---------------------------------------------------------------------------

  app.get(
    '/settlements/:idempotencyKey',
    {
      onRequest: cors('authenticated'),
      preHandler: requireApiKey,
    },
    async (req, reply) => {
      const { idempotencyKey } = req.params;
      const record =
        typeof settlementStore.getConsistent === 'function'
          ? await settlementStore.getConsistent(idempotencyKey)
          : await settlementStore.get(idempotencyKey);
      if (!record) {
        return reply.code(404).send({ error: 'not_found', message: 'Settlement record not found' });
      }

      if (req.keyId && record.key_id && record.key_id.toUpperCase() !== req.keyId) {
        return reply.code(404).send({ error: 'not_found', message: 'Settlement record not found' });
      }

      return reply.send({ ok: true, settlement: record });
    },
  );

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

      if (req.keyId && record.key_id && record.key_id.toUpperCase() !== req.keyId) {
        return reply.code(404).send({ error: 'not_found', message: 'Settlement record not found' });
      }

      const events = await settlementStore.getEventLog(idempotencyKey);
      return reply.send({ ok: true, idempotencyKey, events });
    },
  );

  // ---------------------------------------------------------------------------
  // Discovery Routes
  // ---------------------------------------------------------------------------

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
        return rejectRateLimited(req, reply, '/discovery/resources', checkCatalog, audit);

      const validation = validateForCatalog(body.paymentPayload, body.paymentRequirements);
      if (validation.hardDrop) {
        return reply.code(400).send({ error: 'invalid_resource', reason: validation.reason });
      }

      const recorded = await rateLimiter.recordCatalog(req);
      const limited = handleRateLimit(reply, recorded, checkCatalog);
      if (limited) return limited;

      try {
        const existing = await catalog.getResource?.(
          validation.resource.url,
          validation.resource.toolName ?? null,
        );
        const entry = await catalog.upsertResource(validation.resource, 'manual');
        // Announce the write so peer replicas drop their cached searches (#392).
        // The local replica is already correct — the write bumped the version
        // that keys the cache — but without this broadcast the other replicas
        // would keep serving the previous generation until their TTL expires.
        await catalog.searchCache?.invalidate({ reason: 'cataloging:manual' });
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

  app.get('/discovery/resources', { onRequest: cors('public') }, async (req, reply) => {
    annotateSpan({ 'tenant.id': req.keyId ?? 'open', 'http.route': '/discovery/resources' });
    const checkCatalogRead = await rateLimiter.checkCatalogRead(req);
    if (!checkCatalogRead.allowed)
      return rejectRateLimited(req, reply, '/discovery/resources', checkCatalogRead, audit);

    let extensions;
    if (req.query.extensions) {
      extensions = Array.isArray(req.query.extensions)
        ? req.query.extensions
        : req.query.extensions.split(',');
    }

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

    const cache = applyDiscoveryCache(req, reply, catalog, config.discoveryCache, params);
    if (cache.notModified) return reply.code(304).send();

    try {
      const result = await catalog.listResources(params);
      const recorded = await rateLimiter.recordCatalogRead(req);
      const limited = handleRateLimit(reply, recorded, checkCatalogRead);
      if (limited) return limited;

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

  app.get('/discovery/search', { onRequest: cors('public') }, async (req, reply) => {
    annotateSpan({ 'tenant.id': req.keyId ?? 'open', 'http.route': '/discovery/search' });
    const checkCatalogRead = await rateLimiter.checkCatalogRead(req);
    if (!checkCatalogRead.allowed)
      return rejectRateLimited(req, reply, '/discovery/search', checkCatalogRead, audit);

    if (!req.query.query) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'query is required' });
    }

    let extensions;
    if (req.query.extensions) {
      extensions = Array.isArray(req.query.extensions)
        ? req.query.extensions
        : req.query.extensions.split(',');
    }

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

    const cache = applyDiscoveryCache(req, reply, catalog, config.discoveryCache, params);
    if (cache.notModified) return reply.code(304).send();

    try {
      const result = await catalog.search(params);
      const recorded = await rateLimiter.recordCatalogRead(req);
      const limited = handleRateLimit(reply, recorded, checkCatalogRead);
      if (limited) return limited;

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

  // ---------------------------------------------------------------------------
  // DLQ and Preflight Routes
  // ---------------------------------------------------------------------------

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

  app.options('/supported', { onRequest: cors('public') }, preflight('public'));
  app.options('/discovery/search', { onRequest: cors('public') }, preflight('public'));
  app.options(
    '/discovery/resources',
    { onRequest: cors('authenticated') },
    preflight('authenticated'),
  );
  app.options('/verify', { onRequest: cors('authenticated') }, preflight('authenticated'));
  app.options('/settle', { onRequest: cors('authenticated') }, preflight('authenticated'));

  // ---------------------------------------------------------------------------
  // 404 and Error Handlers
  // ---------------------------------------------------------------------------

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not_found', reason: 'route_not_found' });
  });

  app.setErrorHandler((err, req, reply) => {
    console.error(`[Error] ${err?.type ?? err?.code ?? err?.name ?? 'Error'}: ${err?.message}`);

    let status = err?.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    let code = 'internal_error';

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
        invalidMessage: describeThrown(err),
      });
    }
    if (path === '/settle') {
      return reply.code(status).send({
        success: false,
        errorReason: code,
        errorMessage: describeThrown(err),
        transaction: '',
        network: req.body?.paymentRequirements?.network,
      });
    }
    return reply.code(status).send({ error: code, reason: code });
  });

  return app;
}
