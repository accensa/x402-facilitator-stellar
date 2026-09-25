/**
 * The HTTP surface.
 *
 * What is under test is the transport — status codes, reason codes, pass-through
 * fidelity, auth and rate-limit wiring. ExactStellarScheme is upstream's and is
 * stubbed throughout: reimplementing or re-verifying it is what this repo exists
 * not to do.
 *
 * Nothing here touches the network or needs a funded account.
 *
 * Testing strategy: every test boots the real Fastify app from src/app.js via
 * the serve() harness and drives it over HTTP, swapping only the collaborators
 * (facilitator, rate limiter, catalog, settlement store, audit sink, lock,
 * webhooks). A failure mode is exercised by handing the app a collaborator that
 * fails in that way, never by reaching into app internals, so each assertion is
 * about what a client actually sees on the wire.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  serve,
  testConfig,
  stubFacilitator,
  stubRateLimiter,
  stubCatalog,
  VALID_BODY,
} from './helpers/app.js';
import { MemoryCatalogStore, CatalogError } from '../src/catalog/memory.js';
import { MemorySettlementStore } from '../src/store/memory.js';
import { requestState } from '../src/request-state.js';

// A body that actually produces a catalog entry: VALID_BODY has no discovery
// extension, so validateForCatalog hard-drops it. This one does.
const CATALOGABLE_BODY = {
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

describe('GET /healthz', () => {
  let app;
  before(async () => {
    app = await serve();
  });
  after(() => app.close());

  test('reports liveness', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('GET /supported', () => {
  test('passes getSupported() through untouched, extra block and all', async () => {
    // The Stellar extra block carrying areFeesSponsored is an explicit
    // acceptance item, so the transport must not reshape it on the way out.
    const supported = {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'stellar:testnet',
          extra: { areFeesSponsored: true },
        },
      ],
      extensions: [],
      signers: { 'stellar:*': ['GABC'] },
    };
    const app = await serve({ facilitator: stubFacilitator({ getSupported: () => supported }) });
    try {
      const res = await app.get('/supported');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), supported);
    } finally {
      await app.close();
    }
  });

  test('stays open when API keys are configured', async () => {
    // A client has to read /supported before it has any relationship with us.
    // Putting it behind auth breaks discovery.
    const app = await serve({ config: testConfig({ apiKeys: ['admin:s3cret'] }) });
    try {
      assert.equal((await app.get('/supported')).status, 200);
      assert.equal((await app.get('/healthz')).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('malformed bodies always carry a reason', () => {
  let app;
  before(async () => {
    app = await serve();
  });
  after(() => app.close());

  for (const route of ['/verify', '/settle']) {
    for (const [label, body] of [
      ['an empty object', {}],
      ['paymentPayload only', { paymentPayload: VALID_BODY.paymentPayload }],
      ['paymentRequirements only', { paymentRequirements: VALID_BODY.paymentRequirements }],
      ['a null payload', { paymentPayload: null, paymentRequirements: {} }],
    ]) {
      test(`POST ${route} with ${label} → 400 and a non-null reason`, async () => {
        const res = await app.post(route, body);
        assert.equal(res.status, 400);
        const json = await res.json();
        // A null reason anywhere is an acceptance failure — an agent has to
        // branch on a code rather than parse prose. /verify and /settle
        // disagree on the rest of the shape, so only the reason vocabulary
        // is shared.
        if (route === '/settle') {
          assert.equal(json.success, false);
          assert.equal(json.errorReason, 'invalid_request');
          assert.ok(json.errorMessage, 'errorMessage must not be empty');
          assert.equal(json.transaction, '');
        } else {
          assert.equal(json.isValid, false);
          assert.equal(json.invalidReason, 'invalid_request');
          assert.ok(json.invalidMessage, 'invalidMessage must not be empty');
        }
      });
    }
  }

  test('POST /settle with a malformed body keeps the settle response shape (#68)', async () => {
    // /verify and /settle disagree on what a rejection looks like: settle
    // still needs `transaction` and `network` even on a transport-level
    // rejection, so a client can attribute the failure without correlating
    // out of band.
    const res = await app.post('/settle', { paymentPayload: VALID_BODY.paymentPayload });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.errorReason, 'invalid_request');
    assert.ok(json.errorMessage);
    assert.equal(json.transaction, '');
    // No paymentRequirements was sent at all, so there is no network to
    // report — matching the existing facilitator_error catch path's
    // convention of passing through whatever the body did/didn't carry.
    assert.equal(json.network, undefined);
  });

  for (const route of ['/verify', '/settle']) {
    test(`POST ${route} rejects a non-object paymentPayload (#68)`, async () => {
      const res = await app.post(route, {
        paymentPayload: 'not-an-object',
        paymentRequirements: VALID_BODY.paymentRequirements,
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      const reason = route === '/settle' ? json.errorReason : json.invalidReason;
      const message = route === '/settle' ? json.errorMessage : json.invalidMessage;
      assert.equal(reason, 'invalid_request');
      assert.match(message, /paymentPayload/);
    });

    test(`POST ${route} rejects a network this instance does not serve, by name (#68)`, async () => {
      const res = await app.post(route, {
        paymentPayload: VALID_BODY.paymentPayload,
        paymentRequirements: { ...VALID_BODY.paymentRequirements, network: 'stellar:pubnet' },
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      const reason = route === '/settle' ? json.errorReason : json.invalidReason;
      // Distinct from invalid_request so a client can branch on it.
      assert.equal(reason, 'unsupported_network');
    });

    test(`POST ${route} passes payload.payload through un-inspected (#68)`, async () => {
      // An unrecognised field inside payload must not cause rejection — that
      // content is the scheme's to judge, not the transport's.
      const facilitator = stubFacilitator();
      const app2 = await serve({ facilitator });
      try {
        const body = {
          paymentPayload: {
            ...VALID_BODY.paymentPayload,
            payload: { transaction: 'AAAAAgAAAA...', anUnrecognisedField: { nested: true } },
          },
          paymentRequirements: VALID_BODY.paymentRequirements,
        };
        const res = await app2.post(route, body);
        assert.equal(res.status, 200);
      } finally {
        await app2.close();
      }
    });
  }
});

describe('POST /verify', () => {
  test('passes the payload and requirements through unmodified', async () => {
    const facilitator = stubFacilitator();
    const app = await serve({ facilitator });
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { isValid: true });

      const call = facilitator.calls[0];
      assert.equal(call.name, 'verify');
      // Unwrapped, un-renamed, verbatim — including payload.transaction, which
      // is the shape the spec defines and the one easiest to mangle in transit.
      assert.deepEqual(call.payload, VALID_BODY.paymentPayload);
      assert.equal(call.payload.payload.transaction, 'AAAAAgAAAA...');
      assert.deepEqual(call.requirements, VALID_BODY.paymentRequirements);
    } finally {
      await app.close();
    }
  });

  test('a thrown facilitator becomes a 200 verification failure, not a 500', async () => {
    // A 500 with an empty body is indistinguishable from the service being down
    // and carries no reason code.
    const app = await serve({
      facilitator: stubFacilitator({
        verify: async () => {
          throw new Error('no scheme registered for stellar:pubnet');
        },
      }),
    });
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.isValid, false);
      assert.equal(json.invalidReason, 'facilitator_error');
      assert.match(json.invalidMessage, /no scheme registered/);
    } finally {
      await app.close();
    }
  });

  test('a non-Error throw still produces a reason and a message', async () => {
    const app = await serve({
      facilitator: stubFacilitator({
        verify: async () => {
          throw 'a bare string';
        },
      }),
    });
    try {
      const json = await (await app.post('/verify', VALID_BODY)).json();
      assert.equal(json.invalidReason, 'facilitator_error');
      assert.equal(json.invalidMessage, 'a bare string');
    } finally {
      await app.close();
    }
  });

  test('a scheme rejection is passed through, not rewritten', async () => {
    // The scheme owns its vocabulary. The transport must not translate
    // invalid_exact_stellar_payload into something of its own invention.
    const app = await serve({
      facilitator: stubFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'invalid_exact_stellar_payload_authorization_not_signed',
          invalidMessage: 'payer signature missing',
          payer: 'GPAYER',
        }),
      }),
    });
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        isValid: false,
        invalidReason: 'invalid_exact_stellar_payload_authorization_not_signed',
        invalidMessage: 'payer signature missing',
        payer: 'GPAYER',
      });
    } finally {
      await app.close();
    }
  });
});

describe('POST /settle', () => {
  test('passes the scheme result through untouched', async () => {
    const app = await serve();
    try {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        success: true,
        transaction: 'abc123',
        network: 'stellar:testnet',
      });
    } finally {
      await app.close();
    }
  });

  test('a thrown facilitator still returns transaction and network', async () => {
    // SettleResponse requires both even on failure, so a client can attribute
    // the failure without correlating out of band.
    const app = await serve({
      facilitator: stubFacilitator({
        settle: async () => {
          throw new Error('rpc unreachable');
        },
      }),
    });
    try {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.errorReason, 'facilitator_error');
      assert.match(json.errorMessage, /rpc unreachable/);
      assert.equal(json.transaction, '');
      assert.equal(json.network, 'stellar:testnet');
    } finally {
      await app.close();
    }
  });

  test('repeated settlement crosses feeSpd and returns fee_ceiling_exceeded', async () => {
    // We use the real RateLimiter to test the integration.
    const { testConfig } = await import('./helpers/app.js');
    const { RateLimiter } = await import('../src/rate-limit.js');
    // feeSpd sits above the 50000-stroop worst-case reservation (checkSettle
    // reserves the max fee before settling) so the first settle passes; two
    // settles then cross the ceiling.
    const rateLimiter = new RateLimiter({
      global: { verifyRpm: 100, settleRpm: 100, settleRph: 100, settleRpd: 100, feeSpd: 150000 },
      keys: {
        CUSTOM_KEY: {
          verifyRpm: 100,
          settleRpm: 100,
          settleRph: 100,
          settleRpd: 100,
          feeSpd: 75000,
        },
      },
    });

    const app = await serve({
      config: testConfig({ apiKeys: ['custom_key:secret'] }),
      rateLimiter,
      facilitator: stubFacilitator({
        settle: async () => ({
          success: true,
          transaction: 'tx1',
          network: 'stellar:testnet',
        }),
      }),
    });

    try {
      let res = await app.post('/settle', VALID_BODY, { authorization: 'Bearer secret' });
      assert.equal(res.status, 200);

      res = await app.post('/settle', VALID_BODY, { authorization: 'Bearer secret' });
      assert.equal(res.status, 429);
      const json = await res.json();
      assert.equal(json.reason, 'fee_ceiling_exceeded');
    } finally {
      await app.close();
    }
  });

  test('the sponsored fee is reported to the rate limiter', async () => {
    // The daily fee ceiling is what actually bounds the loss on pubnet, and it
    // is only as good as the number the settle path hands it.
    const rateLimiter = stubRateLimiter();
    const app = await serve({
      rateLimiter,
      facilitator: stubFacilitator({
        settle: async () => ({
          success: true,
          transaction: 'tx',
          network: 'stellar:testnet',
        }),
      }),
    });
    try {
      const resp = await app.post('/settle', VALID_BODY);
      if (resp.status !== 200) console.log(await resp.text());
      const recorded = rateLimiter.recorded.find(r => r.name === 'recordSettle');
      assert.equal(recorded.fee, 50000);
    } finally {
      await app.close();
    }
  });

  test('a failed settlement records no fee', async () => {
    const rateLimiter = stubRateLimiter();
    const app = await serve({
      rateLimiter,
      facilitator: stubFacilitator({
        settle: async () => ({ success: false, errorReason: 'insufficient_funds' }),
      }),
    });
    try {
      await app.post('/settle', VALID_BODY);
      const recorded = rateLimiter.recorded.find(r => r.name === 'recordSettle');
      assert.equal(recorded.fee, 0);
    } finally {
      await app.close();
    }
  });
});

describe('rate limiting', () => {
  test('an allowed request carries the RateLimit headers', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('ratelimit-limit'), '60');
      assert.equal(res.headers.get('ratelimit-remaining'), '59');
      assert.ok(res.headers.get('ratelimit-reset'), 'reset must be present');
    } finally {
      await app.close();
    }
  });

  for (const route of ['/verify', '/settle']) {
    test(`a refused ${route} returns 429 with Retry-After and a reason`, async () => {
      const app = await serve({ rateLimiter: stubRateLimiter({ allow: false }) });
      try {
        const res = await app.post(route, VALID_BODY);
        assert.equal(res.status, 429);
        const retryAfter = Number(res.headers.get('retry-after'));
        assert.ok(retryAfter >= 1, 'Retry-After must be a positive number of seconds');
        const json = await res.json();
        assert.equal(json.isValid, false);
        // An agent has to be able to back off on a code rather than parse prose.
        assert.ok(json.invalidReason, 'a 429 must carry a reason');
      } finally {
        await app.close();
      }
    });
  }

  test('a refused request never reaches the facilitator', async () => {
    // Otherwise the limit bounds the response, not the work or the fee.
    const facilitator = stubFacilitator();
    const app = await serve({ facilitator, rateLimiter: stubRateLimiter({ allow: false }) });
    try {
      await app.post('/settle', VALID_BODY);
      assert.deepEqual(facilitator.calls, [], 'settle must not be called when rate limited');
    } finally {
      await app.close();
    }
  });

  test('a malformed body does not consume verify budget', async () => {
    // A caller sending junk should get a 400, not be pushed toward their limit.
    const rateLimiter = stubRateLimiter();
    const app = await serve({ rateLimiter });
    try {
      await app.post('/verify', {});
      assert.deepEqual(rateLimiter.recorded, []);
    } finally {
      await app.close();
    }
  });
});

describe('GET /usage', () => {
  test('is refused in open mode with a distinct reason', async () => {
    // With no keys there is no caller identity, so there is no usage to scope.
    const app = await serve();
    try {
      const res = await app.get('/usage');
      assert.equal(res.status, 401);
      assert.equal((await res.json()).invalidReason, 'open_mode_usage_forbidden');
    } finally {
      await app.close();
    }
  });

  test('returns the calling key own usage', async () => {
    const app = await serve({ config: testConfig({ apiKeys: ['admin:s3cret'] }) });
    try {
      const res = await app.get('/usage', { authorization: 'Bearer s3cret' });
      assert.equal(res.status, 200);
      const json = await res.json();
      // Scoped to the presented key, not to the whole instance. Key ids are
      // normalized to uppercase at auth.
      assert.equal(json.keyId, 'ADMIN');
    } finally {
      await app.close();
    }
  });

  test('is refused without a key when keys are configured', async () => {
    const app = await serve({ config: testConfig({ apiKeys: ['admin:s3cret'] }) });
    try {
      assert.equal((await app.get('/usage')).status, 401);
    } finally {
      await app.close();
    }
  });
});

describe('automatic cataloging', () => {
  /** Cataloging is enqueued, so give the microtask queue a turn before asserting. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  test('a catalog that throws does not fail the payment', async () => {
    // The claim in the code is that cataloging "must never delay or fail a
    // payment". Until the surface moved into createApp there was no way to
    // point a broken catalog at it and find out.
    const catalog = stubCatalog({
      upsertResource: async () => {
        throw new Error('catalog is on fire');
      },
    });
    const app = await serve({ catalog });
    try {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).success, true);
      await settle();
    } finally {
      await app.close();
    }
  });

  test('POST /discovery/resources returns JSON, not HTML, when the limiter errors', async () => {
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkCatalog = () => {
      throw new Error('limiter is on fire');
    };
    const app = await serve({ rateLimiter });
    try {
      const res = await app.post('/discovery/resources', VALID_BODY);
      assert.equal(res.status, 500);
      const contentType = res.headers.get('content-type');
      assert.equal(contentType.includes('application/json'), true);
      const json = await res.json();
      assert.equal(json.error, 'internal_error');
    } finally {
      await app.close();
    }
  });

  test('a synchronous catalog error (e.g. rate limiter crash) does not fail the payment', async () => {
    const rateLimiter = stubRateLimiter({ allow: true });
    rateLimiter.checkCatalog = () => {
      throw new Error('limiter is on fire');
    };
    const app = await serve({ rateLimiter });
    try {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).success, true);
    } finally {
      await app.close();
    }
  });

  test('a slow catalog does not hold up the payment response', async () => {
    const catalog = stubCatalog({
      upsertResource: () => new Promise(resolve => setTimeout(resolve, 2000)),
    });
    const app = await serve({ catalog });
    try {
      const started = Date.now();
      const res = await app.post('/settle', VALID_BODY);
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.ok(elapsed < 1000, `payment took ${elapsed}ms; cataloging is on the hot path`);
    } finally {
      await app.close();
    }
  });

  test('a failed settlement is not catalogued', async () => {
    // Only a payment that actually happened is evidence a resource is real.
    const catalog = stubCatalog();
    const app = await serve({
      catalog,
      facilitator: stubFacilitator({
        settle: async () => ({ success: false, errorReason: 'insufficient_funds' }),
      }),
    });
    try {
      await app.post('/settle', VALID_BODY);
      await settle();
      assert.deepEqual(catalog.stored, []);
    } finally {
      await app.close();
    }
  });

  test('an invalid verification is not catalogued', async () => {
    const catalog = stubCatalog();
    const app = await serve({
      catalog,
      facilitator: stubFacilitator({
        verify: async () => ({ isValid: false, invalidReason: 'expired_payment' }),
      }),
    });
    try {
      await app.post('/verify', VALID_BODY);
      await settle();
      assert.deepEqual(catalog.stored, []);
    } finally {
      await app.close();
    }
  });
});

describe('RateLimit-Remaining reflects the post-count state (issue #141)', () => {
  test('/verify decrements to zero and refuses exactly the request after the budget runs out', async () => {
    const { RateLimiter } = await import('../src/rate-limit.js');
    const rateLimiter = new RateLimiter({
      global: { verifyRpm: 3, settleRpm: 100, settleRph: 100, settleRpd: 100, feeSpd: 1000000 },
      keys: {},
    });
    const app = await serve({
      config: testConfig({ apiKeys: ['custom_key:secret'] }),
      rateLimiter,
      facilitator: stubFacilitator(),
    });
    try {
      const headers = { authorization: 'Bearer secret' };
      const remaining = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await app.post('/verify', VALID_BODY, headers);
        remaining.push({
          status: res.status,
          remaining: Number(res.headers.get('ratelimit-remaining')),
        });
      }
      // 3 allowances: the current request is counted before headers are emitted,
      // so remaining drops 2 -> 1 -> 0, then the fourth is refused as a 429.
      assert.deepEqual(remaining, [
        { status: 200, remaining: 2 },
        { status: 200, remaining: 1 },
        { status: 200, remaining: 0 },
        { status: 429, remaining: 0 },
      ]);
    } finally {
      await app.close();
    }
  });

  test('/settle decrements to zero and refuses exactly the request after the budget runs out', async () => {
    const { RateLimiter } = await import('../src/rate-limit.js');
    const rateLimiter = new RateLimiter({
      global: { verifyRpm: 100, settleRpm: 3, settleRph: 100, settleRpd: 100, feeSpd: 1000000 },
      keys: {},
    });
    const app = await serve({
      config: testConfig({ apiKeys: ['custom_key:secret'] }),
      rateLimiter,
      facilitator: stubFacilitator({
        settle: async () => ({ success: true, transaction: 'tx', network: 'stellar:testnet' }),
      }),
    });
    try {
      const headers = { authorization: 'Bearer secret' };
      const remaining = [];
      for (let i = 0; i < 4; i += 1) {
        // Distinct bodies so each call is a genuine settlement, not an
        // idempotent replay (a replay would not consume budget).
        const body = {
          ...VALID_BODY,
          paymentPayload: { ...VALID_BODY.paymentPayload, payload: { tx: `tx-${i}` } },
        };
        const res = await app.post('/settle', body, headers);
        remaining.push({
          status: res.status,
          remaining: Number(res.headers.get('ratelimit-remaining')),
        });
      }
      assert.deepEqual(remaining, [
        { status: 200, remaining: 2 },
        { status: 200, remaining: 1 },
        { status: 200, remaining: 0 },
        { status: 429, remaining: 0 },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('catalog provenance and provisional lifecycle (issue #140)', () => {
  test('a verify without settle catalogues a provisional, expiring listing', async () => {
    const catalog = new MemoryCatalogStore({ catalogVerifyTtlMs: 600_000 });
    const app = await serve({
      catalog,
      facilitator: stubFacilitator({
        verify: async () => ({ isValid: true }),
      }),
    });
    try {
      const res = await app.post('/verify', CATALOGABLE_BODY);
      assert.equal(res.status, 200);
      await new Promise(r => setTimeout(r, 50));

      const discovery = await app.get('/discovery/resources');
      const body = await discovery.json();
      assert.equal(body.items.length, 1);
      const entry = body.items[0];
      assert.equal(entry.source, 'verify');
      assert.equal(entry.provisional, true);
      assert.ok(entry.expires_at, 'provisional listing must carry an expiry');

      const stored = await catalog.getResource(entry.url);
      assert.equal(stored.source, 'verify');
      assert.equal(stored.provisional, true);
      assert.ok(stored.expires_at > Date.now());
    } finally {
      await app.close();
    }
  });

  test('a settle promotes a provisional listing to permanent public state', async () => {
    const catalog = new MemoryCatalogStore({ catalogVerifyTtlMs: 600_000 });
    const app = await serve({
      catalog,
      facilitator: stubFacilitator({
        verify: async () => ({ isValid: true }),
        settle: async () => ({ success: true, transaction: 'tx', network: 'stellar:testnet' }),
      }),
    });
    try {
      const headers = { authorization: 'Bearer secret' };
      // First a verify-only pass leaves a provisional listing.
      await app.post('/verify', CATALOGABLE_BODY, headers);
      await new Promise(r => setTimeout(r, 50));
      const before = (await (await app.get('/discovery/resources')).json()).items[0];
      assert.equal(before.source, 'verify');

      // Then an actual settlement promotes it.
      await app.post('/settle', CATALOGABLE_BODY, headers);
      await new Promise(r => setTimeout(r, 50));
      const after = (await (await app.get('/discovery/resources')).json()).items[0];
      assert.equal(after.source, 'settle');
      assert.equal(after.provisional, false);
      assert.equal(after.expires_at, null);

      const stored = await catalog.getResource(after.url);
      assert.equal(stored.source, 'settle');
      assert.equal(stored.provisional, false);
      assert.equal(stored.expires_at, null);
    } finally {
      await app.close();
    }
  });

  test('a settle on its own catalogues a permanent listing', async () => {
    const catalog = new MemoryCatalogStore({ catalogVerifyTtlMs: 600_000 });
    const app = await serve({
      catalog,
      facilitator: stubFacilitator({
        settle: async () => ({ success: true, transaction: 'tx', network: 'stellar:testnet' }),
      }),
    });
    try {
      await app.post('/settle', CATALOGABLE_BODY, { authorization: 'Bearer secret' });
      await new Promise(r => setTimeout(r, 50));
      const entry = (await (await app.get('/discovery/resources')).json()).items[0];
      assert.equal(entry.source, 'settle');
      assert.equal(entry.provisional, false);
      assert.equal(entry.expires_at, null);
    } finally {
      await app.close();
    }
  });

  test('an unsettled verify-only listing disappears from discovery once it expires', async () => {
    // Short TTL so the test does not wait out a real window.
    const catalog = new MemoryCatalogStore({ catalogVerifyTtlMs: 150 });
    const app = await serve({
      catalog,
      facilitator: stubFacilitator({
        verify: async () => ({ isValid: true }),
      }),
    });
    try {
      const headers = { authorization: 'Bearer secret' };
      await app.post('/verify', CATALOGABLE_BODY, headers);
      // Give the enqueued (off-hot-path) catalog write time to land while the
      // 150ms window still puts the listing in the public view.
      await new Promise(r => setTimeout(r, 60));
      assert.equal((await (await app.get('/discovery/resources')).json()).items.length, 1);

      await new Promise(r => setTimeout(r, 180));
      assert.equal((await (await app.get('/discovery/resources')).json()).items.length, 0);

      const pruned = await catalog.pruneExpired();
      assert.equal(pruned, 1);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases and failure modes (#366).
//
// Each block below targets one branch of src/app.js the suites above never
// reached. The pattern is the same throughout: build the app with exactly one
// collaborator misbehaving (or one config knob set), make the request a client
// would make, and assert on status, reason code and headers.
// ---------------------------------------------------------------------------

/**
 * Boots an app with `options`, runs `fn` against it and always closes it.
 *
 * @param {Parameters<typeof serve>[0]} options - forwarded to serve()
 * @param {(app: Awaited<ReturnType<typeof serve>>) => Promise<void>} fn
 */
async function withApp(options, fn) {
  const app = await serve(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/**
 * An audit sink that keeps every record, so a test can assert an abuse or
 * failure signal was emitted rather than scraping stdout.
 *
 * @returns {{audit: Function, records: Array<{event: string} & object>}}
 */
function captureAudit() {
  const records = [];
  return { records, audit: (event, fields) => records.push({ event, ...fields }) };
}

/** Decodes the base64 EXTENSION-RESPONSES header into its `bazaar` outcome. */
function bazaarOutcome(res) {
  const raw = res.headers.get('extension-responses');
  assert.ok(raw, 'EXTENSION-RESPONSES header must be present');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).bazaar;
}

/** A promise that never settles: stands in for a scheme call that hangs. */
const never = () => new Promise(() => {});

/** An Error carrying a `code`, the way the RPC breaker and timeouts tag theirs. */
const codedError = (message, code) => Object.assign(new Error(message), { code });

/** A catalogable body whose `resource` is replaced by `resource`. */
function catalogableWith(resource) {
  return {
    ...CATALOGABLE_BODY,
    paymentPayload: {
      ...CATALOGABLE_BODY.paymentPayload,
      resource: { ...CATALOGABLE_BODY.paymentPayload.resource, ...resource },
    },
  };
}

describe('transport hardening', () => {
  test('HSTS is sent only when NODE_ENV=production; nosniff always', async () => {
    await withApp({ nodeEnv: 'production' }, async app => {
      const res = await app.get('/healthz');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/);
    });
    await withApp({}, async app => {
      const res = await app.get('/healthz');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('strict-transport-security'), null);
    });
  });

  test('a numeric TRUST_PROXY trusts exactly that many X-Forwarded-For hops', async () => {
    // Identity pseudonymizer so the resolved address is observable as-is.
    const seen = [];
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkVerify = req => {
      seen.push(req.ip);
      return { allowed: true, limit: 60, remaining: 59, resetAt: 0 };
    };
    const extras = { ipPseudonymizer: ip => ip };
    const headers = { 'x-forwarded-for': '198.51.100.66, 203.0.113.9' };

    await withApp({ config: testConfig({ trustProxy: 1 }), rateLimiter, extras }, async app => {
      await app.post('/verify', VALID_BODY, headers);
      // No header at all: the connection peer is the only hop there is.
      await app.post('/verify', VALID_BODY);
    });
    await withApp({ config: testConfig({ trustProxy: 0 }), rateLimiter, extras }, async app => {
      await app.post('/verify', VALID_BODY, headers);
    });

    // One trusted hop: the proxy's view of the caller, never the spoofable
    // leftmost entry. Zero hops: the socket peer, whatever the header claims.
    assert.deepEqual(seen, ['203.0.113.9', '127.0.0.1', '127.0.0.1']);
  });

  test('an unknown route is a 404 with a reason code', async () => {
    await withApp({}, async app => {
      const res = await app.get('/no/such/route');
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'not_found', reason: 'route_not_found' });
    });
  });
});

describe('error boundary', () => {
  test('malformed JSON keeps each route’s own rejection shape', async () => {
    await withApp({}, async app => {
      const verify = await app.post('/verify', '{not json');
      assert.equal(verify.status, 400);
      const v = await verify.json();
      assert.equal(v.isValid, false);
      assert.equal(v.invalidReason, 'malformed_json');

      const settle = await app.post('/settle', '{not json');
      assert.equal(settle.status, 400);
      const s = await settle.json();
      assert.equal(s.success, false);
      assert.equal(s.errorReason, 'malformed_json');
      assert.equal(s.transaction, '');

      // Any other route falls back to the generic {error, reason} shape.
      const other = await app.post('/discovery/resources', '{not json');
      assert.equal(other.status, 400);
      assert.deepEqual(await other.json(), { error: 'malformed_json', reason: 'malformed_json' });
    });
  });

  test('a body over the 256kb cap is a 413 payload_too_large', async () => {
    await withApp({}, async app => {
      const huge = JSON.stringify({ ...VALID_BODY, pad: 'x'.repeat(300 * 1024) });
      const res = await app.post('/verify', huge);
      assert.equal(res.status, 413);
      assert.equal((await res.json()).invalidReason, 'payload_too_large');
    });
  });

  test('a limiter that throws inside /verify surfaces as a 500 verification failure', async () => {
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkVerify = () => {
      throw new Error('limiter down');
    };
    await withApp({ rateLimiter }, async app => {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 500);
      const json = await res.json();
      assert.equal(json.isValid, false);
      assert.equal(json.invalidReason, 'internal_error');
    });
  });
});

describe('CORS preflight', () => {
  const origin = 'https://agent.example';

  test('public routes answer * when no allowlist is configured', async () => {
    await withApp({}, async app => {
      const res = await app.request('/supported', { method: 'OPTIONS', headers: { origin } });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
      assert.equal(res.headers.get('access-control-max-age'), '600');
    });
  });

  test('authenticated routes grant only allowlisted origins', async () => {
    await withApp({ corsAllowedOrigins: [origin] }, async app => {
      const granted = await app.request('/verify', { method: 'OPTIONS', headers: { origin } });
      assert.equal(granted.status, 204);
      assert.equal(granted.headers.get('access-control-allow-origin'), origin);
      assert.equal(granted.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
      assert.match(granted.headers.get('access-control-allow-headers'), /Authorization/);

      // Still a 204, but with no grant: the browser blocks the real request.
      const refused = await app.request('/settle', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(refused.status, 204);
      assert.equal(refused.headers.get('access-control-allow-origin'), null);

      // Once an allowlist exists, public routes stop defaulting to *.
      const publicRefused = await app.request('/discovery/search', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(publicRefused.headers.get('access-control-allow-origin'), null);
    });
  });
});

describe('API key header forms', () => {
  const config = testConfig({ apiKeys: ['alice:a-secret'] });

  for (const [label, authorization, status, reason] of [
    ['a bare key without the Bearer prefix', 'a-secret', 200, null],
    ['a Bearer with nothing after it', 'Bearer', 401, 'malformed_auth_header'],
    ['a Bearer followed by only a space', 'Bearer ', 401, 'malformed_auth_header'],
    ['a non-Bearer scheme', 'Basic a-secret', 401, 'malformed_auth_header'],
    ['a Bearer token containing a space', 'Bearer a secret', 401, 'malformed_auth_header'],
    ['a wrong key', 'Bearer nope', 401, 'invalid_api_key'],
  ]) {
    test(`${label} → ${status}`, async () => {
      await withApp({ config }, async app => {
        const res = await app.post('/verify', VALID_BODY, { authorization });
        assert.equal(res.status, status);
        if (reason) assert.equal((await res.json()).invalidReason, reason);
      });
    });
  }
});

describe('GET /readyz', () => {
  test('without a readiness checker it reports not_ready, with failover state', async () => {
    const failoverHealth = { getState: () => ({ region: 'eu-west' }) };
    await withApp({ extras: { failoverHealth } }, async app => {
      const res = await app.get('/readyz');
      assert.equal(res.status, 503);
      const json = await res.json();
      assert.equal(json.reason, 'readiness_not_configured');
      assert.deepEqual(json.failover, { region: 'eu-west' });
    });
  });

  test('passes the checker report through, 200 when ok and 503 when not', async () => {
    for (const ok of [true, false]) {
      const readiness = { check: async () => ({ ok, checks: [] }) };
      const failoverHealth = { getState: () => ({ region: 'us-east' }) };
      await withApp({ extras: { readiness, failoverHealth } }, async app => {
        const res = await app.get('/readyz');
        assert.equal(res.status, ok ? 200 : 503);
        const json = await res.json();
        assert.equal(json.ok, ok);
        assert.deepEqual(json.failover, { region: 'us-east' });
      });
    }
  });

  test('a checker that throws is a 503 carrying the error message', async () => {
    const readiness = {
      check: async () => {
        throw new Error('probe exploded');
      },
    };
    await withApp({ extras: { readiness } }, async app => {
      const res = await app.get('/readyz');
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'probe exploded');
    });
  });

  test('a config with per-network data builds the real checker', async () => {
    // Only construction is exercised: no /readyz call, so no RPC is contacted.
    const config = { ...testConfig(), perNetwork: { 'stellar:testnet': {} } };
    await withApp({ config }, async app => {
      assert.ok(app.app.readiness, 'a readiness checker should be decorated onto the app');
    });
  });
});

describe('GET /metrics', () => {
  test('serves Prometheus text with seeded signer gauges', async () => {
    const extras = { signers: { 'stellar:testnet': 'GSIGNER', 'stellar:pubnet': null } };
    await withApp({ extras }, async app => {
      // A settlement flips the in-flight gauge to 1 and back to 0.
      assert.equal((await app.post('/settle', VALID_BODY)).status, 200);

      const res = await app.get('/metrics');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /version=0\.0\.4/);
      const text = await res.text();
      assert.match(text, /x402_signer_inflight\{network="stellar:testnet",signer="GSIGNER"\} 0/);
      // A network with no signer configured gets no series.
      assert.doesNotMatch(text, /network="stellar:pubnet"/);
    });
  });

  test('is not served on this listener when serveMetrics is false', async () => {
    await withApp({ extras: { serveMetrics: false } }, async app => {
      assert.equal((await app.get('/metrics')).status, 404);
    });
  });
});

describe('POST /verify scheme failures map to distinct reason codes', () => {
  for (const [label, verify, config, reason] of [
    [
      'a scheme call that outlives requestTimeoutMs',
      never,
      { requestTimeoutMs: 20 },
      'request_timeout',
    ],
    [
      'an open RPC breaker',
      async () => {
        throw codedError('breaker open', 'RPC_BREAKER_OPEN');
      },
      {},
      'soroban_rpc_unreachable',
    ],
    [
      'an unregistered scheme/network',
      async () => {
        throw new Error('scheme exact is unregistered for stellar:testnet');
      },
      {},
      'unsupported_scheme_network',
    ],
  ]) {
    test(`${label} → ${reason}, audited as rpc_unreachable`, async () => {
      const { audit, records } = captureAudit();
      await withApp(
        {
          config: { ...testConfig(), ...config },
          facilitator: stubFacilitator({ verify }),
          extras: { audit },
        },
        async app => {
          const res = await app.post('/verify', VALID_BODY);
          assert.equal(res.status, 200);
          const json = await res.json();
          assert.equal(json.isValid, false);
          assert.equal(json.invalidReason, reason);
        },
      );
      const record = records.find(r => r.event === 'rpc_unreachable');
      assert.ok(record, 'a non-generic scheme failure must be audited');
      assert.equal(record.op, 'verify');
      assert.equal(record.reason, reason);
    });
  }
});

describe('POST /settle scheme failures map to distinct reason codes', () => {
  /** Settles once and returns the JSON body plus the stored record. */
  async function settleWith({ facilitator, config = {}, extras = {}, body = VALID_BODY }) {
    const settlementStore = new MemorySettlementStore();
    let json;
    await withApp(
      {
        config: { ...testConfig(), ...config },
        facilitator,
        extras: { settlementStore, ...extras },
        distributedLock: extras.distributedLock,
      },
      async app => {
        const res = await app.post('/settle', body, { 'idempotency-key': 'k-fail' });
        assert.equal(res.status, 200);
        json = await res.json();
      },
    );
    return { json, record: await settlementStore.get('k-fail') };
  }

  test('a scheme call that outlives requestTimeoutMs → request_timeout, state failed', async () => {
    const { json, record } = await settleWith({
      facilitator: stubFacilitator({ settle: never }),
      config: { requestTimeoutMs: 20 },
    });
    assert.equal(json.errorReason, 'request_timeout');
    assert.equal(json.network, 'stellar:testnet');
    assert.equal(record.state, 'failed');
  });

  test('a timeout after submission → submitted_outcome_unknown, state unknown', async () => {
    const { json, record } = await settleWith({
      facilitator: stubFacilitator({
        settle: () => {
          // What the scheme wrapper does once the transaction is on the wire.
          requestState.getStore().submitted = true;
          return never();
        },
      }),
      config: { requestTimeoutMs: 20 },
    });
    assert.equal(json.errorReason, 'submitted_outcome_unknown');
    assert.equal(record.state, 'unknown');
  });

  test('a lock that cannot be acquired → lock_timeout', async () => {
    const distributedLock = {
      withLock: async () => {
        const err = new Error('lock busy');
        err.name = 'LockAcquireTimeoutError';
        throw err;
      },
    };
    const { json } = await settleWith({
      facilitator: stubFacilitator(),
      extras: { distributedLock },
    });
    assert.equal(json.errorReason, 'lock_timeout');
  });

  test('an open RPC breaker → soroban_rpc_unreachable, audited', async () => {
    const { audit, records } = captureAudit();
    const { json } = await settleWith({
      facilitator: stubFacilitator({
        settle: async () => {
          throw codedError('breaker open', 'RPC_BREAKER_OPEN');
        },
      }),
      extras: { audit },
    });
    assert.equal(json.errorReason, 'soroban_rpc_unreachable');
    assert.ok(records.some(r => r.event === 'rpc_unreachable' && r.op === 'settle'));
  });

  test('an unregistered scheme/network → unsupported_scheme_network', async () => {
    const { json } = await settleWith({
      facilitator: stubFacilitator({
        settle: async () => {
          throw new Error('unregistered scheme');
        },
      }),
    });
    assert.equal(json.errorReason, 'unsupported_scheme_network');
  });

  test('a string paymentPayload.transaction is echoed back on failure', async () => {
    const body = {
      ...VALID_BODY,
      paymentPayload: { ...VALID_BODY.paymentPayload, transaction: 'AAAA-signed-xdr' },
    };
    const { json, record } = await settleWith({
      facilitator: stubFacilitator({
        settle: async () => {
          throw new Error('boom');
        },
      }),
      body,
    });
    assert.equal(json.errorReason, 'facilitator_error');
    assert.equal(json.transaction, 'AAAA-signed-xdr');
    assert.equal(record.tx_hash, 'AAAA-signed-xdr');
  });
});

describe('POST /settle idempotent replay from the settlement store', () => {
  const NETWORK = 'stellar:testnet';

  /**
   * Seeds a store with one record under `key`, walked to `state`, and serves an
   * app over it. The facilitator counts calls so a test can prove a replay never
   * touched the chain.
   */
  async function replay(state, details = {}) {
    const settlementStore = new MemorySettlementStore();
    await settlementStore.save({ idempotency_key: 'k1', network: NETWORK, payer: 'GPAYER' });
    if (state !== 'submitted') await settlementStore.updateState('k1', state, details);

    let settleCalls = 0;
    const facilitator = stubFacilitator({
      settle: async () => {
        settleCalls += 1;
        return { success: true, transaction: 'fresh-tx', network: NETWORK };
      },
    });
    let json;
    await withApp({ facilitator, extras: { settlementStore } }, async app => {
      const res = await app.post('/settle', VALID_BODY, { 'idempotency-key': 'k1' });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('ratelimit-limit'), 'a replay still carries RateLimit-*');
      json = await res.json();
    });
    return { json, settleCalls };
  }

  test('a settled record with a stored response replays that response', async () => {
    const stored = { success: true, transaction: 'tx-stored', network: NETWORK };
    const { json, settleCalls } = await replay('settled', {
      tx_hash: 'tx-stored',
      response: stored,
    });
    assert.deepEqual(json, stored);
    assert.equal(settleCalls, 0);
  });

  test('a stored response saved as a JSON string is parsed before replay', async () => {
    const stored = { success: true, transaction: 'tx-str', network: NETWORK };
    const { json } = await replay('settled', { response: JSON.stringify(stored) });
    assert.deepEqual(json, stored);
  });

  test('a settled record without a response is rebuilt from its fields', async () => {
    const { json, settleCalls } = await replay('settled', { tx_hash: 'tx-bare' });
    assert.deepEqual(json, {
      success: true,
      transaction: 'tx-bare',
      network: NETWORK,
      payer: 'GPAYER',
    });
    assert.equal(settleCalls, 0);
  });

  test('a submitted (in-flight) record reports submitted_outcome_unknown', async () => {
    const { json, settleCalls } = await replay('submitted');
    assert.equal(json.success, false);
    assert.equal(json.errorReason, 'submitted_outcome_unknown');
    assert.equal(json.errorMessage, 'settlement in progress or outcome unknown');
    assert.equal(settleCalls, 0);
  });

  test('a terminally failed record replays its failure', async () => {
    const { json, settleCalls } = await replay('failed', {
      error_reason: 'invalid_payload',
      error_message: 'bad signature',
    });
    assert.equal(json.errorReason, 'invalid_payload');
    assert.equal(json.errorMessage, 'bad signature');
    assert.equal(settleCalls, 0);
  });

  test('a terminally failed record with a stored response replays that response', async () => {
    const stored = {
      success: false,
      errorReason: 'invalid_payload',
      transaction: '',
      network: NETWORK,
    };
    const { json } = await replay('failed', { error_reason: 'invalid_payload', response: stored });
    assert.deepEqual(json, stored);
  });

  test('a retryable failure is settled again rather than replayed', async () => {
    const { json, settleCalls } = await replay('failed', { error_reason: 'request_timeout' });
    assert.equal(settleCalls, 1);
    assert.equal(json.transaction, 'fresh-tx');
  });
});

describe('POST /settle optional collaborators', () => {
  /** An idempotency store that records begin/complete calls. */
  function recordingIdempotency(beginResult) {
    const completed = [];
    return {
      completed,
      keyFor: () => 'idem-1',
      begin: async key => beginResult ?? { replayed: false, key },
      complete: async (key, status, response) => completed.push({ key, status, response }),
    };
  }

  test('a replayed idempotency key returns the recorded status and body', async () => {
    const idempotency = recordingIdempotency({
      replayed: true,
      statusCode: 200,
      response: { success: true, transaction: 'earlier', network: 'stellar:testnet' },
    });
    await withApp({ idempotency }, async app => {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).transaction, 'earlier');
    });
  });

  test('success and failure are both completed on the idempotency store', async () => {
    for (const success of [true, false]) {
      const idempotency = recordingIdempotency();
      const facilitator = stubFacilitator({
        settle: async () =>
          success
            ? { success: true, transaction: 'tx', network: 'stellar:testnet' }
            : { success: false, errorReason: 'insufficient_funds', transaction: '' },
      });
      await withApp({ idempotency, facilitator }, async app => {
        await app.post('/settle', VALID_BODY);
      });
      assert.equal(idempotency.completed.length, 1);
      assert.equal(idempotency.completed[0].key, 'idem-1');
      assert.equal(idempotency.completed[0].response.success, success);
    }
  });

  test('a successful settlement enqueues a settlement.completed webhook', async () => {
    const events = [];
    const webhooks = { enqueue: event => events.push(event) };
    await withApp({ webhooks }, async app => {
      assert.equal((await app.post('/settle', VALID_BODY)).status, 200);
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'settlement.completed');
    assert.equal(events[0].transaction, 'abc123');
    assert.equal(events[0].payTo, VALID_BODY.paymentRequirements.payTo);
  });

  test('a distributed lock serializes the settle call under the payment key', async () => {
    const keys = [];
    const distributedLock = {
      withLock: async (key, fn) => {
        keys.push(key);
        return fn();
      },
    };
    await withApp({ distributedLock }, async app => {
      assert.equal((await (await app.post('/settle', VALID_BODY)).json()).success, true);
    });
    assert.equal(keys.length, 1);
    assert.ok(keys[0], 'the lock key must be derived from the payment');
  });
});

describe('GET /settlements/:idempotencyKey', () => {
  const config = testConfig({ apiKeys: ['alice:a-secret', 'bob:b-secret'] });
  const alice = { authorization: 'Bearer a-secret' };
  const bob = { authorization: 'Bearer b-secret' };

  test('the owner reads the record and its event log; anyone else gets a 404', async () => {
    await withApp({ config }, async app => {
      await app.post('/settle', VALID_BODY, { ...alice, 'idempotency-key': 'k-alice' });

      const own = await app.get('/settlements/k-alice', alice);
      assert.equal(own.status, 200);
      const { settlement } = await own.json();
      assert.equal(settlement.state, 'settled');

      const events = await app.get('/settlements/k-alice/events', alice);
      assert.equal(events.status, 200);
      const log = await events.json();
      assert.equal(log.idempotencyKey, 'k-alice');
      assert.ok(log.events.length >= 2, 'initiated and settled should both be recorded');

      // Another tenant must not learn the settlement exists at all.
      assert.equal((await app.get('/settlements/k-alice', bob)).status, 404);
      assert.equal((await app.get('/settlements/k-alice/events', bob)).status, 404);
    });
  });

  test('an unknown key is a 404 on both routes', async () => {
    await withApp({ config }, async app => {
      for (const path of ['/settlements/missing', '/settlements/missing/events']) {
        const res = await app.get(path, alice);
        assert.equal(res.status, 404);
        assert.equal((await res.json()).error, 'not_found');
      }
    });
  });

  test('a store with getConsistent is read through it', async () => {
    const settlementStore = new MemorySettlementStore();
    await settlementStore.save({ idempotency_key: 'k-c', network: 'stellar:testnet' });
    let consistentReads = 0;
    settlementStore.getConsistent = async key => {
      consistentReads += 1;
      return settlementStore.get(key);
    };
    await withApp({ extras: { settlementStore } }, async app => {
      assert.equal((await app.get('/settlements/k-c')).status, 200);
    });
    assert.equal(consistentReads, 1);
  });
});

describe('POST /discovery/resources (manual registration)', () => {
  test('a structurally invalid body → 400 invalid_resource', async () => {
    await withApp({}, async app => {
      const res = await app.post('/discovery/resources', {});
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_resource', reason: 'invalid_request' });
    });
  });

  test('a refused catalog budget → 429 before any validation', async () => {
    const { audit, records } = captureAudit();
    await withApp(
      {
        rateLimiter: stubRateLimiter({ allow: false, reason: 'catalog_rate_limited' }),
        extras: { audit },
      },
      async app => {
        const res = await app.post('/discovery/resources', CATALOGABLE_BODY);
        assert.equal(res.status, 429);
        assert.ok(res.headers.get('retry-after'));
      },
    );
    assert.ok(
      records.some(r => r.event === 'rate_limit_rejected' && r.route === '/discovery/resources'),
    );
  });

  test('a body with no discovery extension is hard-dropped with its reason', async () => {
    await withApp({}, async app => {
      const res = await app.post('/discovery/resources', VALID_BODY);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, 'missing_or_invalid_discovery_extension');
    });
  });

  test('a catalogable body is stored as manual and audited', async () => {
    const { audit, records } = captureAudit();
    const catalog = new MemoryCatalogStore();
    await withApp({ catalog, extras: { audit } }, async app => {
      const res = await app.post('/discovery/resources', CATALOGABLE_BODY);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.resource.source, 'manual');
      assert.deepEqual(json.softDrops, []);
    });
    const write = records.find(r => r.event === 'catalog_write');
    assert.equal(write.source, 'manual');
    assert.equal(write.overwritten, false);
  });

  test('a catalog error surfaces its code; an uncoded one is catalog_error', async () => {
    for (const [err, reason] of [
      [
        new CatalogError('maximum_resources_per_payto_exceeded', 'full'),
        'maximum_resources_per_payto_exceeded',
      ],
      [new Error('disk on fire'), 'catalog_error'],
    ]) {
      const catalog = stubCatalog({
        upsertResource: async () => {
          throw err;
        },
      });
      await withApp({ catalog }, async app => {
        const res = await app.post('/discovery/resources', CATALOGABLE_BODY);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: 'catalog_error', reason });
      });
    }
  });
});

describe('automatic cataloging outcomes (EXTENSION-RESPONSES)', () => {
  const verifying = stubFacilitator({ verify: async () => ({ isValid: true }) });

  test('a hostile declaration is rejected with its hard-drop code', async () => {
    await withApp({ facilitator: verifying }, async app => {
      const res = await app.post('/verify', catalogableWith({ url: 'ftp://api.ex/x' }));
      assert.equal(res.status, 200);
      assert.deepEqual(bazaarOutcome(res), { status: 'rejected', code: 'invalid_url_scheme' });
    });
  });

  test('a refused catalog budget is rejected and audited, but the payment still succeeds', async () => {
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkCatalog = () => ({
      allowed: false,
      limit: 1,
      remaining: 0,
      resetAt: 0,
      reason: 'catalog_rate_limited',
    });
    const { audit, records } = captureAudit();
    await withApp({ facilitator: verifying, rateLimiter, extras: { audit } }, async app => {
      const res = await app.post('/verify', CATALOGABLE_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).isValid, true);
      assert.deepEqual(bazaarOutcome(res), {
        status: 'rejected',
        code: 'catalog_rate_limited',
        reason: 'catalog_rate_limited',
      });
    });
    const record = records.find(r => r.event === 'rate_limit_rejected');
    assert.equal(record.route, 'catalog');
    assert.equal(record.outcome_override, 'catalog_rate_limited');
  });

  test('soft-dropped fields land as partially landed and name the fields', async () => {
    await withApp({ facilitator: verifying }, async app => {
      const res = await app.post('/verify', catalogableWith({ iconUrl: 'javascript:alert(1)' }));
      assert.deepEqual(bazaarOutcome(res), {
        status: 'partially landed',
        code: 'catalog_partial',
        reason: 'Dropped fields: iconUrl',
      });
    });
  });

  test('re-cataloguing an existing listing is audited as an overwrite', async () => {
    const catalog = new MemoryCatalogStore();
    const { audit, records } = captureAudit();
    await withApp({ facilitator: verifying, catalog, extras: { audit } }, async app => {
      await app.post('/verify', CATALOGABLE_BODY);
      await new Promise(r => setTimeout(r, 30));
      await app.post('/verify', CATALOGABLE_BODY);
      await new Promise(r => setTimeout(r, 30));
    });
    const writes = records.filter(r => r.event === 'catalog_write');
    assert.deepEqual(
      writes.map(w => w.overwritten),
      [false, true],
    );
  });
});

describe('public discovery reads', () => {
  /** A catalog that records the params each read was called with. */
  function recordingCatalog(overrides = {}) {
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

  test('listing pagination is clamped and extensions are split', async () => {
    const { calls, catalog } = recordingCatalog();
    await withApp({ catalog }, async app => {
      await app.get('/discovery/resources?limit=500&offset=-5&extensions=a,b');
      await app.get('/discovery/resources?limit=zero&offset=nope&extensions=a&extensions=b');
      await app.get('/discovery/resources?limit=0');
    });
    assert.deepEqual(
      calls.map(c => [c.limit, c.offset, c.extensions]),
      [
        [100, 0, ['a', 'b']],
        [20, 0, ['a', 'b']],
        [1, 0, undefined],
      ],
    );
  });

  test('search requires a query, and clamps and splits like the listing', async () => {
    const { calls, catalog } = recordingCatalog();
    await withApp({ catalog }, async app => {
      const missing = await app.get('/discovery/search');
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).error, 'invalid_request');

      const res = await app.get('/discovery/search?query=x&limit=999&extensions=a,b&cursor=c1');
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.x402Version, 2);
      assert.equal(json.resources.length, 1);

      await app.get('/discovery/search?query=x&limit=nan&extensions=a&extensions=b');
    });
    assert.deepEqual(
      calls.map(c => [c.query, c.limit, c.extensions, c.cursor]),
      [
        ['x', 100, ['a', 'b'], 'c1'],
        ['x', 20, ['a', 'b'], undefined],
      ],
    );
  });

  test('a matching If-None-Match is a 304 that never reaches the catalog', async () => {
    const catalog = new MemoryCatalogStore();
    await catalog.upsertResource({ type: 'http', url: 'http://api.ex/1', payTo: 'G1' });
    let reads = 0;
    const listResources = catalog.listResources.bind(catalog);
    const search = catalog.search.bind(catalog);
    catalog.listResources = async p => (reads++, listResources(p));
    catalog.search = async p => (reads++, search(p));

    await withApp({ catalog }, async app => {
      for (const path of ['/discovery/resources', '/discovery/search?query=api']) {
        const first = await app.get(path);
        assert.equal(first.status, 200);
        const etag = first.headers.get('etag');
        assert.match(etag, /^W\/"1-/);
        assert.ok(
          first.headers.get('last-modified'),
          'a store with a write time sends Last-Modified',
        );

        const again = await app.get(path, { 'if-none-match': `"other", ${etag}` });
        assert.equal(again.status, 304);
      }
    });
    assert.equal(reads, 2, 'the two 304s must not have re-run the catalog');
  });

  test('a catalog that throws is a JSON 500 on both reads', async () => {
    const { catalog } = recordingCatalog({
      listResources: async () => {
        throw new Error('db down');
      },
      search: async () => {
        throw new Error('db down');
      },
    });
    await withApp({ catalog }, async app => {
      for (const path of ['/discovery/resources', '/discovery/search?query=x']) {
        const res = await app.get(path);
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: 'internal_error', reason: 'internal_error' });
      }
    });
  });

  test('a refused read budget is a 429 on both reads', async () => {
    const rateLimiter = stubRateLimiter({ allow: false, reason: 'catalog_read_rate_limited' });
    await withApp({ rateLimiter }, async app => {
      for (const path of ['/discovery/resources', '/discovery/search?query=x']) {
        const res = await app.get(path);
        assert.equal(res.status, 429);
        assert.equal((await res.json()).reason, 'catalog_read_rate_limited');
      }
    });
  });
});

describe('cataloging failures on a catalogable payment', () => {
  // The two "does not fail the payment" tests in 'automatic cataloging' above
  // send VALID_BODY, which validateForCatalog hard-drops before the limiter or
  // the catalog is ever called. These send a body that is actually catalogued,
  // so the failure really happens inside processCataloging.
  const verifying = stubFacilitator({ verify: async () => ({ isValid: true }) });

  test('an async catalog write that rejects is logged, and the payment is untouched', async () => {
    let attempted = false;
    const catalog = stubCatalog({
      upsertResource: async () => {
        attempted = true;
        throw new Error('catalog is on fire');
      },
    });
    await withApp({ facilitator: verifying, catalog }, async app => {
      const res = await app.post('/verify', CATALOGABLE_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).isValid, true);
      // The outcome is decided before the off-path write runs.
      assert.equal(bazaarOutcome(res).status, 'landed');
      await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(attempted, true, 'the failing write must actually have been attempted');
  });

  test('a limiter that throws mid-cataloging still yields a "not attempted" outcome', async () => {
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkCatalog = () => {
      throw new Error('limiter is on fire');
    };
    await withApp({ facilitator: verifying, rateLimiter }, async app => {
      const res = await app.post('/verify', CATALOGABLE_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).isValid, true);
      assert.deepEqual(bazaarOutcome(res), { status: 'not attempted' });
    });
  });
});

describe('RateLimit headers fall back to the pre-record check', () => {
  test('a limiter whose record call returns no state still yields headers', async () => {
    const rateLimiter = stubRateLimiter();
    rateLimiter.checkVerify = () => ({ allowed: true, limit: 10, remaining: 7, resetAt: 123 });
    rateLimiter.recordVerify = () => undefined;
    await withApp({ rateLimiter }, async app => {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('ratelimit-limit'), '10');
      assert.equal(res.headers.get('ratelimit-remaining'), '7');
      assert.equal(res.headers.get('ratelimit-reset'), '123');
    });
  });
});

describe('DLQ operator routes', () => {
  test('are registered only when a dead-letter store is supplied', async () => {
    const config = testConfig({ apiKeys: ['ops:o-secret'] });
    const headers = { authorization: 'Bearer o-secret' };
    const dlq = {
      store: { list: async () => ({ items: [], total: 0 }) },
      publish: async () => {},
    };
    await withApp({ config, extras: { dlq } }, async app => {
      const res = await app.get('/admin/dlq', headers);
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).items, []);
    });
    await withApp({ config }, async app => {
      assert.equal((await app.get('/admin/dlq', headers)).status, 404);
    });
  });
});
