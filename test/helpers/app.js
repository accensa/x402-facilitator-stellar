/**
 * Shared harness for the HTTP surface tests.
 *
 * Builds the real app from src/app.js with stubbed collaborators. No subprocess,
 * no fixed port, no keypair, no network — a test can make the facilitator throw
 * or the rate limiter refuse, which is not reachable when the server is spawned
 * as a child process and talks to a real scheme.
 */
import { createHash } from 'node:crypto';
import { createApp } from '../../src/app.js';

/**
 * Builds the config shape createApp expects.
 *
 * API keys are given as `id:secret` and hashed here the way resolveConfig does,
 * so a test states the secret it will present rather than a digest.
 */
export function testConfig({
  apiKeys = [],
  networks = ['stellar:testnet'],
  trustProxy,
  corsAllowedOrigins = [],
  nodeEnv = 'development',
} = {}) {
  return {
    trustProxy,
    nodeEnv,
    cors: { allowedOrigins: corsAllowedOrigins },
    apiKeys: apiKeys.map(entry => {
      const idx = entry.indexOf(':');
      const [id, secret] = idx > 0 ? [entry.slice(0, idx), entry.slice(idx + 1)] : ['key_0', entry];
      return { id, hash: createHash('sha256').update(secret).digest() };
    }),
    networks,
  };
}

/** A facilitator that records its calls and returns fixed, inspectable results. */
export function stubFacilitator(overrides = {}) {
  const calls = [];
  return {
    calls,
    getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
    verify: async (payload, requirements) => {
      calls.push({ name: 'verify', payload, requirements });
      return { isValid: true };
    },
    settle: async (payload, requirements) => {
      calls.push({ name: 'settle', payload, requirements });
      return { success: true, transaction: 'abc123', network: requirements.network };
    },
    ...overrides,
  };
}

/**
 * A rate limiter that allows everything and records what it was told.
 *
 * `allow: false` flips it to refusing, which is how the 429 path and its
 * headers get exercised without waiting out a real window.
 */
export function stubRateLimiter({ allow = true, reason = 'verify_rpm_exceeded' } = {}) {
  const resetAt = Math.floor(Date.now() / 1000) + 60;
  const result = () => ({ allowed: allow, limit: 60, remaining: allow ? 59 : 0, resetAt, reason });
  const recorded = [];
  return {
    recorded,
    checkVerify: () => result(),
    checkSettle: () => result(),
    checkCatalog: () => result(),
    checkCatalogRead: () => result(),
    recordCatalog: req => recorded.push({ name: 'recordCatalog', keyId: req.keyId }),
    recordCatalogRead: req => recorded.push({ name: 'recordCatalogRead', keyId: req.keyId }),
    recordVerify: req => recorded.push({ name: 'recordVerify', keyId: req.keyId }),
    recordSettle: (req, fee) => recorded.push({ name: 'recordSettle', keyId: req.keyId, fee }),
    getUsage: keyId => ({ keyId, verify: 1, settle: 2, feeStroops: 3000 }),
  };
}

/**
 * Boots the app on an ephemeral port and returns a client bound to it.
 *
 * Port 0 rather than a fixed one: tests must not collide with each other, nor
 * with a facilitator the developer happens to have running.
 */
export function stubCatalog(overrides = {}) {
  const stored = [];
  return {
    stored,
    upsertResource: async (resource, source) => {
      stored.push({ resource, source });
      return { ...resource, source };
    },
    listResources: async () => ({ items: [], total: 0 }),
    ...overrides,
  };
}

export async function serve({
  config,
  facilitator,
  rateLimiter,
  catalog,
  idempotency,
  distributedLock,
  webhooks,
  corsAllowedOrigins,
  nodeEnv,
  extras,
} = {}) {
  const app = createApp(
    config ?? testConfig({ corsAllowedOrigins, nodeEnv }),
    facilitator ?? stubFacilitator(),
    rateLimiter ?? stubRateLimiter(),
    catalog ?? stubCatalog(),
    idempotency,
    { distributedLock, webhooks, ...extras },
  );

  // Fastify's listen resolves with the bound address once the server is up.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  return {
    base,
    app,
    close: () => app.close(),
    get: (path, headers = {}) => fetch(`${base}${path}`, { headers }),
    post: (path, body, headers = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    request: (path, options = {}) => fetch(`${base}${path}`, options),
  };
}

/** A payment body that satisfies readPaymentBody. Contents are never inspected. */
export const VALID_BODY = {
  paymentPayload: {
    x402Version: 2,
    scheme: 'exact',
    network: 'stellar:testnet',
    payload: { transaction: 'AAAAAgAAAA...' },
  },
  paymentRequirements: {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    maxAmountRequired: '1000',
    payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
  },
};
