/**
 * Process entrypoint.
 *
 * Resolves configuration, builds the facilitator, the rate limiter, the catalog
 * store and the HTTP app, then binds a port. The routes live in app.js so they
 * can be exercised in a test without a listener, a real signer or a subprocess —
 * this file is only the wiring a test has no use for.
 */
import dotenv from 'dotenv';
import http from 'node:http';
import { resolveConfig } from './config.js';
import { buildFacilitator } from './facilitator.js';
import { installHorizonClient } from './horizon-client.js';
import { installRpcRetry } from './rpc-retry.js';
import { createRequestLog } from './log.js';
import { createMetrics } from './metrics.js';
import { RateLimiter } from './rate-limit.js';
import { createRateLimitStore, MemoryStore } from './rate-limit-store.js';
import { RedisRateLimiter } from './redis-rate-limit.js';
import { CrdtRateLimitStore } from './crdt-rate-limit-store.js';
import { createDistributedLock } from './distributed-lock.js';
import { buildIdempotencyStore } from './idempotency.js';
import { MemoryCatalogStore } from './catalog/memory.js';
import { createWebhookDispatcher } from './webhooks/dispatcher.js';
import { FailoverHealthChecker } from './failover-health.js';
import { createApp } from './app.js';

// A .env file is a development convenience, not a deployment mechanism — in
// production the environment comes from the orchestrator, so a stray .env left
// next to the image must not be able to override or shadow it. resolveConfig()
// below runs after this so a misconfiguration still fails at start.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ quiet: true });
}

// Must run BEFORE installRpcRetry: the retry wrapper composes on top of
// whatever fetch is global when it installs. Innermost first — pooled sockets
// and the per-origin breaker (#120) sit under connection-level retries and the
// RPC breaker (#105). The two breakers are complementary layers, not
// duplicates: #105 counts connection-level failures per RPC host; #120 also
// bounds sockets and trips on slow responses for every backend origin.
const horizon = installHorizonClient({ log: msg => console.log(`  ${msg}`) });

// Retries connection-level failures only; see rpc-retry.js for what that
// deliberately excludes. The returned handle exposes circuit-breaker state
// for the readiness probe (#100). onRetry feeds x402_rpc_retries_total.
const metrics = createMetrics();
const rpc = installRpcRetry({
  log: msg => console.warn(`  ${msg}`),
  onStateChange: msg => console.warn(`  [Breaker] ${msg}`),
  onRetry: ({ code }) => metrics.incRpcRetry({ code }),
});

const config = resolveConfig();

// Vault-managed database pool (#127): when VAULT_ADDR is set, Postgres
// credentials come from Vault's database secrets engine (AppRole login, lease
// rotation) instead of a long-lived password in DATABASE_URL, which then
// carries host/port/database only. The one pool is shared by every
// database-backed store. If Vault is unreachable at boot there is no cached
// lease yet, so this is null and each store falls back to its degrade path.
// Must be created before any store below that may use it.
const vaultDatabase =
  config.vault && config.databaseUrl
    ? await createVaultManagedDatabase({
        vault: config.vault,
        databaseUrl: config.databaseUrl,
        warn: msg => console.warn(msg),
        log: msg => console.log(msg),
      })
    : null;

// Issue #94: limiter state lives behind a store interface. RATE_LIMIT_STORE is
// unset by default -> in-memory Map, exactly the pre-#94 behaviour. Set it to
// 'postgres' (with DATABASE_URL) to share counters across replicas and keep the
// daily fee ceiling alive across restarts. A misconfiguration refuses to start:
// silently falling back to per-process memory would double every limit at two
// replicas and reset the fee ceiling at every deploy — the bug this fixes.

const { facilitator, signers } = buildFacilitator(config);

// Store selection, in order of preference:
//   1. RATE_LIMIT_STORE=crdt (#126): CRDT G-Counter store for multi-region
//      deployments. Uses CockroachDB/multi-region Postgres for global state
//      with local counters that survive partitions.
//   2. REDIS_URL (upstream): Redis-backed rate limiter with memory fallback.
//   3. RATE_LIMIT_STORE=postgres (#94): Postgres-backed shared store.
//   4. Default: per-process memory.
let rateLimiter;
let crdtStore = null;
let rateLimitStore;
if (config.rateLimitStore === 'crdt' && config.databaseUrl) {
  crdtStore = new CrdtRateLimitStore({
    region: config.region || 'default',
    databaseUrl: config.databaseUrl,
    maxSize: 10000,
  });
  // RateLimiter expects the { global, keys, perNetwork } limits shape, which
  // lives at config.rateLimits — passing the whole config would leave
  // `global` undefined and crash every rate-limited route.
  rateLimiter = new RateLimiter(config.rateLimits, crdtStore);
} else if (config.redisUrl) {
  rateLimiter = new RedisRateLimiter(config.rateLimits, { redisUrl: config.redisUrl });
} else {
  rateLimitStore = createRateLimitStore(process.env, {
    maxSize: 10000,
    pool: vaultDatabase?.pool,
  });
  rateLimitStore.ready?.catch(err => {
    console.error(`[RateLimit] shared store failed to initialise: ${err.message}`);
  });
  rateLimiter = new RateLimiter(config.rateLimits, rateLimitStore);
}
const catalog = new MemoryCatalogStore(config);
const idempotency = buildIdempotencyStore(config, { pool: vaultDatabase?.pool });

// Cross-process serialization for state transitions (#116). Absent config
// means single-instance in-process locking.
const distributedLock = config.redisNodes.length
  ? createDistributedLock({ nodes: config.redisNodes })
  : null;

// Webhook delivery off the critical path (#117).
const webhooks = await createWebhookDispatcher({
  brokers: config.kafka.brokers,
  clientId: config.kafka.clientId,
  topic: config.kafka.topic,
  groupId: config.kafka.groupId,
  url: config.webhookUrl,
});

// Multi-region failover health (#126).
const failoverHealth = config.region
  ? new FailoverHealthChecker({
      region: config.region,
      regions: config.regions,
      warn: msg => console.warn(`  ${msg}`),
      log: msg => console.log(`  ${msg}`),
    })
  : null;
import { buildSettlementStore } from './store/index.js';
import { startReconciliationLoop } from './store/reconciliation.js';
import { startOutboxWorker } from './outbox/index.js';
import { createVaultManagedDatabase } from './vault/index.js';
const settlementStore = buildSettlementStore(config, { pool: vaultDatabase?.pool });
const reconciliation = startReconciliationLoop(settlementStore, config);

// Transactional outbox (#123): the settle path writes the notification in the
// same transaction as the 'settled' state change (see app.js); this worker
// polls those rows and publishes them through the webhook dispatcher. It runs
// only when there is something durable to poll (Postgres) and something to
// publish to; otherwise the app falls back to the fire-and-forget webhook
// path, which is the pre-outbox behaviour.
const outbox = settlementStore.outbox ?? null;
const outboxWorker =
  outbox && typeof webhooks.publish === 'function'
    ? startOutboxWorker({
        outbox,
        publish: record => webhooks.publish(record),
        intervalMs: config.outboxPollIntervalMs,
        log: msg => console.warn(msg),
      })
    : null;
outboxWorker?.start();

const app = createApp(config, facilitator, rateLimiter, catalog, idempotency, {
  breakerStates: rpc?.getBreakerStates,
  distributedLock,
  webhooks,
  logger: createRequestLog({ level: config.logLevel }),
  metrics,
  signers,
  // When METRICS_PORT is set the metrics listener below owns /metrics; keep it
  // off the public listener so it cannot be scraped by untrusted callers.
  serveMetrics: config.metricsPort == null,

  failoverHealth,
  settlementStore,
});

// Set by the METRICS_PORT branch below; closed on shutdown when present.
let metricsServerRef = null;

app.listen({ port: config.port, host: '0.0.0.0' }, () => {
  console.log(`x402 Stellar facilitator listening on :${config.port}`);
  console.log(`  networks : ${config.networks.join(', ')}`);
  for (const network of config.networks) {
    const netConfig = config.perNetwork[network];
    console.log(`  [${network}]`);
    console.log(`    signer : ${signers[network]}`);
    console.log(`    rpc    : ${netConfig.rpcUrl ?? '(package default)'}`);
    console.log(`    max fee: ${netConfig.maxTransactionFeeStroops} stroops`);
  }
  if (config.apiKeys.length === 0) {
    console.log('  auth     : OPEN — no API keys configured (fine for free testnet)');
  } else {
    console.log(`  auth     : ${config.apiKeys.length} API key(s) configured`);
  }
  if (config.trustProxy !== undefined) {
    console.log(
      `  proxy    : trust proxy set to ${Array.isArray(config.trustProxy) ? config.trustProxy.join(', ') : config.trustProxy}`,
    );
  }
  // Never log the URLs themselves: they may embed credentials.
  console.log(
    `  state    : ${[
      config.redisUrl
        ? 'redis rate limits'
        : crdtStore
          ? `crdt rate limits (${config.region})`
          : rateLimitStore instanceof MemoryStore
            ? 'in-memory rate limits'
            : rateLimitStore
              ? `postgres rate limits (${rateLimitStore.constructor.name})`
              : 'in-memory rate limits',
      config.databaseUrl ? 'postgres idempotency' : 'in-memory idempotency',
      distributedLock ? `redlock (${config.redisNodes.length} node(s))` : 'in-process locking',
      webhooks.kind === 'kafka'
        ? `kafka webhooks (${config.kafka.brokers.length} broker(s))`
        : 'direct webhooks',
      config.region ? `region: ${config.region}` : null,
    ]
      .filter(Boolean)
      .join(', ')}`,
  );

  // Start failover health monitoring (#126).
  if (failoverHealth) {
    failoverHealth.start();
    console.log(`  failover : ${config.regions.length} region(s) configured`);
  }

  // The consumer group performs actual webhook delivery; the producer is
  // already wired by the dispatcher constructor path above.
  webhooks.start().catch(err => {
    console.warn(`webhooks: consumer failed to start (${err.message}); events still publish`);
  });

  // Optional separate metrics listener. Off the public port by design: an
  // operator binds METRICS_PORT to an internal interface and scrapes it from
  // there, so the payment surface never serves /metrics. When unset, /metrics
  // is served on the main listener instead (see createApp's serveMetrics).
  if (config.metricsPort != null) {
    const metricsServer = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        });
        res.end(metrics.render());
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    metricsServer.listen(config.metricsPort, '0.0.0.0', () => {
      console.log(`metrics listening on :${config.metricsPort} (METRICS_PORT)`);
    });
    // Track for graceful shutdown.
    metricsServerRef = metricsServer;
  }
});

/**
 * Graceful shutdown: stop accepting, drain in-flight requests, then close the
 * Kafka client, Redis connections and the pooled sockets behind them.
 */
async function shutdown(signal) {
  console.log(`${signal} received — draining`);
  if (app.readiness && typeof app.readiness.setShuttingDown === 'function') {
    app.readiness.setShuttingDown();
  }

  const graceMs = config.shutdownGraceMs ?? 15_000;
  let forceExitTimer;

  const shutdownPromise = (async () => {
    try {
      reconciliation?.stop();
      await outboxWorker?.stop();
      await vaultDatabase?.stop();
      await app.close();
      await new Promise(resolve =>
        metricsServerRef ? metricsServerRef.close(resolve) : resolve(),
      );
      await webhooks.stop().catch(() => {});
      await distributedLock?.quit()?.catch(() => {});
      await crdtStore?.close().catch(() => {});

      failoverHealth?.stop();

      await rateLimiter?.close?.().catch(() => {});
      horizon.restore();
    } catch (err) {
      console.error(`Error during shutdown: ${err.message}`);
    }
  })();

  const timeoutPromise = new Promise(resolve => {
    forceExitTimer = setTimeout(() => {
      const inFlight = typeof app.getInFlightCount === 'function' ? app.getInFlightCount() : 0;
      console.warn(
        `[Shutdown] Deadline of ${graceMs}ms reached; ${inFlight} request(s) still in flight.`,
      );
      resolve('timeout');
    }, graceMs);
  });

  await Promise.race([shutdownPromise, timeoutPromise]);
  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
