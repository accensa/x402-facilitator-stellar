/**
 * The HTTP surface.
 *
 * What is under test is the transport — status codes, reason codes, pass-through
 * fidelity, auth and rate-limit wiring. ExactStellarScheme is upstream's and is
 * stubbed throughout: reimplementing or re-verifying it is what this repo exists
 * not to do.
 *
 * Nothing here touches the network or needs a funded account.
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
