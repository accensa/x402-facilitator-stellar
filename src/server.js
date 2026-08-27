/**
 * Process entrypoint.
 *
 * Resolves configuration, builds the facilitator, the rate limiter, the catalog
 * store and the HTTP app, then binds a port. The routes live in app.js so they
 * can be exercised in a test without a listener, a real signer or a subprocess —
 * this file is only the wiring a test has no use for.
 */
import dotenv from 'dotenv';
import { resolveConfig } from './config.js';
import { buildFacilitator } from './facilitator.js';
import { installHorizonClient } from './horizon-client.js';
import { installRpcRetry } from './rpc-retry.js';
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
// for the readiness probe (#100).
const rpc = installRpcRetry({
  log: msg => console.warn(`  ${msg}`),
  onStateChange: msg => console.warn(`  [Breaker] ${msg}`),
});

const config = resolveConfig();

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
  });
  rateLimiter = new RateLimiter(config.rateLimits, crdtStore);
} else if (config.redisUrl) {
  rateLimiter = new RedisRateLimiter(config.rateLimits, { redisUrl: config.redisUrl });
} else {
  rateLimitStore = createRateLimitStore();
  rateLimitStore.ready?.catch(err => {
    console.error(`[RateLimit] shared store failed to initialise: ${err.message}`);
  });
  rateLimiter = new RateLimiter(config.rateLimits, rateLimitStore);
}
const catalog = new MemoryCatalogStore(config);
const idempotency = buildIdempotencyStore(config);

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

const settlementStore = buildSettlementStore(config);
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
  failoverHealth,
  settlementStore,
});

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
});

/**
 * Graceful shutdown: stop accepting, drain in-flight requests, then close the
 * Kafka client, Redis connections and the pooled sockets behind them.
 */
async function shutdown(signal) {
  console.log(`${signal} received — draining`);
  try {
    await app.close();
    await webhooks.stop().catch(() => {});
    await distributedLock?.quit().catch(() => {});
    await crdtStore?.close().catch(() => {});
    failoverHealth?.stop();
    horizon.restore();
  } finally {
    process.exit(0);
  if (app.readiness && typeof app.readiness.setShuttingDown === 'function') {
    app.readiness.setShuttingDown();
  }

  const graceMs = config.shutdownGraceMs ?? 15_000;
  let forceExitTimer;

  const shutdownPromise = (async () => {
    try {
      reconciliation?.stop();
      await outboxWorker?.stop();
      await app.close();
      await webhooks.stop().catch(() => {});
      await distributedLock?.quit().catch(() => {});
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
