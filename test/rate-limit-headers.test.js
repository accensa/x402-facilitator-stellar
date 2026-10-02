/**
 * How often a request is allowed to touch the rate-limit headers (#209).
 *
 * The header/rejection logic used to live in two wrappers with eight call
 * sites, so a request could reach it twice (pre-record check, then post-record
 * state) — and the post-record call sites threw the result away, which meant a
 * post-record refusal was followed by the route's own `reply.send(...)`: a
 * double send, which Fastify answers with a 500 instead of the 429.
 *
 * `handleRateLimit` is internal to app.js, so these tests count its observable
 * side effect — a write of `RateLimit-Limit` — per request. One write per
 * request is the property under test; a second one means the decision is being
 * made twice again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { RateLimiter } from '../src/rate-limit.js';
import {
  testConfig,
  stubFacilitator,
  stubRateLimiter,
  stubCatalog,
  VALID_BODY,
} from './helpers/app.js';

const FUTURE = Math.floor(Date.now() / 1000) + 60;

/**
 * A payment body that actually catalogs: `VALID_BODY` carries no discovery
 * extension, so POST /discovery/resources hard-drops it with a 400 before any
 * rate-limit header is worth writing. Same shape as the fixture in
 * test/app.test.js (issue #140).
 */
const CATALOGABLE_BODY = {
  paymentPayload: {
    x402Version: 2,
    scheme: 'exact',
    network: 'stellar:testnet',
    resource: {
      url: 'http://api.ex/209',
      serviceName: 'rate-limit-headers',
      description: 'demo',
    },
    extensions: {
      bazaar: {
        info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
        schema: { type: 'object' },
        routeTemplate: '/209',
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

const GLOBAL_LIMITS = {
  verifyRpm: 100,
  settleRpm: 100,
  settleRph: 100,
  settleRpd: 100,
  feeSpd: 1_000_000,
};

/**
 * Boots the real app with an instrumented `reply.header`, so each request
 * reports how many times it wrote `RateLimit-Limit` and with what status.
 */
async function serveCounting({ rateLimiter, catalog, facilitator, config } = {}) {
  const app = await createApp(
    config ?? testConfig(),
    facilitator ?? stubFacilitator(),
    rateLimiter ?? stubRateLimiter(),
    catalog ?? stubCatalog(),
  );

  const observed = [];
  app.addHook('onRequest', (req, reply, done) => {
    req.rlWrites = 0;
    const header = reply.header.bind(reply);
    reply.header = (name, value) => {
      if (name === 'RateLimit-Limit') req.rlWrites += 1;
      return header(name, value);
    };
    done();
  });
  app.addHook('onResponse', (req, reply, done) => {
    observed.push({
      method: req.method,
      url: req.url.split('?')[0],
      status: reply.statusCode,
      writes: req.rlWrites,
    });
    done();
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    observed,
    close: () => app.close(),
    get: path => fetch(`${base}${path}`),
    post: (path, body) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

test('#209: every limited route writes the RateLimit-* headers exactly once per request', async () => {
  const client = await serveCounting({
    rateLimiter: new RateLimiter({ global: GLOBAL_LIMITS, keys: {} }),
    // The stub catalog has no search(); GET /discovery/search needs one.
    catalog: stubCatalog({
      search: async () => ({ resources: [], partialResults: true, pagination: {} }),
    }),
  });
  try {
    const responses = [
      ['POST /verify', await client.post('/verify', VALID_BODY)],
      ['POST /settle', await client.post('/settle', VALID_BODY)],
      ['POST /discovery/resources', await client.post('/discovery/resources', CATALOGABLE_BODY)],
      ['GET /discovery/resources', await client.get('/discovery/resources')],
      ['GET /discovery/search', await client.get('/discovery/search?query=weather')],
    ];

    for (const [label, res] of responses) {
      assert.equal(res.status, 200, `${label} must succeed`);
      for (const header of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
        assert.ok(res.headers.get(header) !== null, `${label} must set ${header}`);
      }
    }

    assert.deepEqual(
      client.observed.map(o => `${o.method} ${o.url} -> ${o.writes}`),
      [
        'POST /verify -> 1',
        'POST /settle -> 1',
        'POST /discovery/resources -> 1',
        'GET /discovery/resources -> 1',
        'GET /discovery/search -> 1',
      ],
      'each request decides the headers once — a 2 means the decision moved back into two places',
    );
  } finally {
    await client.close();
  }
});

test('#209: a post-record refusal IS the response — the route must not send over it', async () => {
  const facilitator = stubFacilitator();
  const client = await serveCounting({
    facilitator,
    // checkVerify allows, so the route proceeds; the recorded state then says
    // the budget is spent. The recorded state is the fresher truth.
    rateLimiter: {
      ...stubRateLimiter(),
      recordVerify: () => ({
        allowed: false,
        limit: 3,
        remaining: 0,
        resetAt: FUTURE,
        reason: 'verify_rpm_exceeded',
      }),
    },
  });
  try {
    const res = await client.post('/verify', VALID_BODY);

    assert.equal(res.status, 429, 'the refusal is the answer, not a 500 from a second send');
    const body = await res.json();
    assert.equal(body.invalidReason, 'rate_limited');
    assert.equal(body.reason, 'verify_rpm_exceeded');
    assert.equal(res.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(res.headers.get('retry-after')) >= 1, 'a 429 carries Retry-After');
    assert.equal(client.observed.at(-1).writes, 1, 'the refusal path writes the headers once too');
    assert.deepEqual(
      facilitator.calls,
      [],
      'a refused request must stop there — the honoured return value is what skips the payment work',
    );
  } finally {
    await client.close();
  }
});

test('#209: a pre-record refusal is answered once, with the headers and Retry-After', async () => {
  const client = await serveCounting({ rateLimiter: stubRateLimiter({ allow: false }) });
  try {
    const res = await client.post('/verify', VALID_BODY);

    assert.equal(res.status, 429);
    assert.equal((await res.json()).invalidReason, 'rate_limited');
    assert.equal(res.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    assert.equal(client.observed.at(-1).writes, 1);
  } finally {
    await client.close();
  }
});

test('#209: the discovery write path emits the headers the HTTP-surface audit promises', async () => {
  // POST /discovery/resources checked and recorded against the catalog bucket
  // but never emitted a single RateLimit-* header, so the audit table in
  // docs/HTTP-SURFACE-AUDIT.md described a surface the wire did not have.
  const rateLimiter = new RateLimiter({
    global: { ...GLOBAL_LIMITS, catalogRpm: 5 },
    keys: {},
  });
  const client = await serveCounting({ rateLimiter });
  try {
    const res = await client.post('/discovery/resources', CATALOGABLE_BODY);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ratelimit-limit'), '5');
    assert.equal(
      res.headers.get('ratelimit-remaining'),
      '4',
      'the advertised remaining is the post-record state (this request counted)',
    );
  } finally {
    await client.close();
  }
});

test('#209: a limiter that returns no post-record state still gets headers from the check', async () => {
  const client = await serveCounting({
    rateLimiter: { ...stubRateLimiter(), recordVerify: () => undefined },
  });
  try {
    const res = await client.post('/verify', VALID_BODY);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ratelimit-limit'), '60');
    assert.equal(res.headers.get('ratelimit-remaining'), '59');
  } finally {
    await client.close();
  }
});
