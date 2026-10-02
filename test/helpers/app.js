/**
 * Shared harness for the HTTP surface tests.
 *
 * Builds the real app from src/app.js with stubbed collaborators. No subprocess,
 * no fixed port, no keypair, no network — a test can make the facilitator throw
 * or the rate limiter refuse, which is not reachable when the server is spawned
 * as a child process and talks to a real scheme.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { stubRateLimiter } from './rate-limiter.js';

// Re-exported so existing importers keep one entry point; the definition lives
// in ./rate-limiter.js so limiter-only suites can use it without loading the app.
export { stubRateLimiter };

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
  const app = await createApp(
    config ?? testConfig({ corsAllowedOrigins, nodeEnv }),
    facilitator ?? stubFacilitator(),
    rateLimiter ?? stubRateLimiter(),
    catalog ?? stubCatalog(),
    idempotency,
    { distributedLock, webhooks, ...extras },
  );

  await app.ready();

  const adapt = res => ({
    status: res.statusCode,
    headers: { get: name => res.headers[name.toLowerCase()] ?? null },
    json: async () => res.json(),
    text: async () => res.payload,
  });

  return {
    app,
    close: async () => app.close(),
    get: async (path, headers = {}) => {
      const res = await app.inject({ method: 'GET', url: path, headers });
      return adapt(res);
    },
    post: async (path, body, headers = {}) => {
      const res = await app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json', ...headers },
        payload: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return adapt(res);
    },
    request: async (path, options = {}) => {
      const res = await app.inject({
        method: options.method || 'GET',
        url: path,
        headers: options.headers || {},
        payload: options.body,
      });
      return adapt(res);
    },
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

/**
 * A body that produces a valid catalog entry with bazaar discovery extension.
 */
export const CATALOGABLE_BODY = {
  paymentPayload: {
    x402Version: 2,
    scheme: 'exact',
    network: 'stellar:testnet',
    resource: { url: 'http://api.ex/140', serviceName: 'provenance-demo', description: 'demo' },
    extensions: {
      bazaar: {
        info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
        schema: { type: 'object' },
        routeTemplate: '/140',
      },
    },
  },
  paymentRequirements: {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    maxAmountRequired: '1000',
    payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
  },
};

/**
 * Creates a catalogable payment body with customized resource fields.
 */
export function catalogableWith(resource) {
  return {
    ...CATALOGABLE_BODY,
    paymentPayload: {
      ...CATALOGABLE_BODY.paymentPayload,
      resource: { ...CATALOGABLE_BODY.paymentPayload.resource, ...resource },
    },
  };
}

/**
 * Boots an app with `options`, runs `fn` against it and always closes it.
 *
 * @param {Parameters<typeof serve>[0]} options - forwarded to serve()
 * @param {(app: Awaited<ReturnType<typeof serve>>) => Promise<void>} fn
 */
export async function withApp(options, fn) {
  const app = await serve(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/**
 * An audit sink that collects all audit events.
 *
 * @returns {{audit: Function, records: Array<{event: string} & object>}}
 */
export function captureAudit() {
  const records = [];
  return { records, audit: (event, fields) => records.push({ event, ...fields }) };
}

/** Decodes the base64 EXTENSION-RESPONSES header into its `bazaar` outcome. */
export function bazaarOutcome(res) {
  const raw = res.headers.get('extension-responses');
  assert.ok(raw, 'EXTENSION-RESPONSES header must be present');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).bazaar;
}

/** A promise that never settles: stands in for a scheme call that hangs. */
export const never = () => new Promise(() => {});

/** An Error carrying a `code`, the way the RPC breaker and timeouts tag theirs. */
export const codedError = (message, code) => Object.assign(new Error(message), { code });

/**
 * An idempotency store test stub that records begin/complete calls.
 */
export function recordingIdempotency(beginResult) {
  const completed = [];
  return {
    completed,
    keyFor: () => 'idem-1',
    begin: async key => beginResult ?? { replayed: false, key },
    complete: async (key, status, response) => completed.push({ key, status, response }),
  };
}

/**
 * A catalog test stub that records list/search query parameters.
 */
export function recordingCatalog(overrides = {}) {
  const calls = [];
  return {
    calls,
    catalog: stubCatalog({
      listResources: async params => {
        calls.push(params);
        return { items: [], total: 0 };
      },
      search: async params => {
        calls.push(params);
        return { resources: [{ url: 'http://x' }], partialResults: false, pagination: {} };
      },
      ...overrides,
    }),
  };
}
