/**
 * The HTTP surface.
 *
 * The facilitator is stubbed throughout: what is under test is the transport —
 * status codes, reason codes, pass-through fidelity and caller auth — not
 * ExactStellarScheme, which is upstream's and is not reimplemented here.
 *
 * Nothing in this file touches the network or needs a funded account.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

/** A payment body that satisfies readPaymentBody. Contents are never inspected. */
const VALID_BODY = {
  paymentPayload: { x402Version: 2, scheme: 'exact', network: 'stellar:testnet' },
  paymentRequirements: { scheme: 'exact', network: 'stellar:testnet' },
};

/**
 * Boots an app on an ephemeral port and returns a fetch bound to it.
 *
 * Port 0 rather than 3402: tests must not collide with a facilitator the
 * developer happens to have running.
 */
async function serve(config, facilitator) {
  const app = createApp({ apiKeys: [], ...config }, facilitator);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    close: () => new Promise(resolve => server.close(resolve)),
    get: path => fetch(`${base}${path}`),
    post: (path, body, headers = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
  };
}

/** A facilitator that records its calls and returns whatever it was given. */
function stubFacilitator(overrides = {}) {
  const calls = [];
  return {
    calls,
    getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
    verify: async (payload, requirements) => {
      calls.push(['verify', payload, requirements]);
      return { isValid: true };
    },
    settle: async (payload, requirements) => {
      calls.push(['settle', payload, requirements]);
      return { success: true, transaction: 'abc', network: requirements.network };
    },
    ...overrides,
  };
}

describe('GET /healthz', () => {
  let app;
  before(async () => {
    app = await serve({}, stubFacilitator());
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
    const app = await serve({}, stubFacilitator({ getSupported: () => supported }));
    try {
      const res = await app.get('/supported');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), supported);
    } finally {
      await app.close();
    }
  });

  test('is reachable without an API key even when keys are configured', async () => {
    // A client has to be able to read /supported before it has any
    // relationship with us. Putting it behind auth breaks discovery.
    const app = await serve({ apiKeys: ['k1'] }, stubFacilitator());
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
    app = await serve({}, stubFacilitator());
  });
  after(() => app.close());

  for (const route of ['/verify', '/settle']) {
    for (const [label, body] of [
      ['an empty object', {}],
      ['paymentPayload only', { paymentPayload: VALID_BODY.paymentPayload }],
      ['paymentRequirements only', { paymentRequirements: VALID_BODY.paymentRequirements }],
      ['a null payload', { paymentPayload: null, paymentRequirements: {} }],
    ]) {
      test(`POST ${route} with ${label} → 400 with a non-null invalidReason`, async () => {
        const res = await app.post(route, body);
        assert.equal(res.status, 400);
        const json = await res.json();
        assert.equal(json.isValid, false);
        // A null reason anywhere is an acceptance failure — an agent has to be
        // able to branch on a code rather than parse prose.
        assert.equal(json.invalidReason, 'invalid_request');
        assert.ok(json.invalidMessage, 'invalidMessage must not be empty');
      });
    }
  }
});

describe('POST /verify', () => {
  test('passes the payload and requirements through unmodified', async () => {
    const facilitator = stubFacilitator();
    const app = await serve({}, facilitator);
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { isValid: true });

      const [name, payload, requirements] = facilitator.calls[0];
      assert.equal(name, 'verify');
      // Unwrapped, un-renamed, verbatim: the spec's payload shape reaches the
      // scheme exactly as it arrived on the wire.
      assert.deepEqual(payload, VALID_BODY.paymentPayload);
      assert.deepEqual(requirements, VALID_BODY.paymentRequirements);
    } finally {
      await app.close();
    }
  });

  test('a thrown facilitator becomes a 200 verification failure, not a 500', async () => {
    // A 500 with an empty body is indistinguishable from the service being
    // down and carries no reason code.
    const app = await serve(
      {},
      stubFacilitator({
        verify: async () => {
          throw new Error('no scheme registered for stellar:pubnet');
        },
      }),
    );
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
    const app = await serve(
      {},
      stubFacilitator({
        verify: async () => {
          throw 'a bare string';
        },
      }),
    );
    try {
      const json = await (await app.post('/verify', VALID_BODY)).json();
      assert.equal(json.invalidReason, 'facilitator_error');
      assert.equal(json.invalidMessage, 'a bare string');
    } finally {
      await app.close();
    }
  });
});

describe('POST /settle', () => {
  test('passes the scheme result through untouched', async () => {
    const app = await serve({}, stubFacilitator());
    try {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        success: true,
        transaction: 'abc',
        network: 'stellar:testnet',
      });
    } finally {
      await app.close();
    }
  });

  test('a thrown facilitator still returns transaction and network', async () => {
    // SettleResponse requires both even on failure, so a client can attribute
    // the failure without correlating out of band.
    const app = await serve(
      {},
      stubFacilitator({
        settle: async () => {
          throw new Error('rpc unreachable');
        },
      }),
    );
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
});

describe('caller authentication', () => {
  test('with no keys configured, /verify is open', async () => {
    const app = await serve({ apiKeys: [] }, stubFacilitator());
    try {
      assert.equal((await app.post('/verify', VALID_BODY)).status, 200);
    } finally {
      await app.close();
    }
  });

  describe('with keys configured', () => {
    let app;
    before(async () => {
      app = await serve({ apiKeys: ['k1', 'k2'] }, stubFacilitator());
    });
    after(() => app.close());

    test('a correct Bearer key is accepted', async () => {
      const res = await app.post('/verify', VALID_BODY, { authorization: 'Bearer k1' });
      assert.equal(res.status, 200);
    });

    test('every configured key works, not just the first', async () => {
      const res = await app.post('/verify', VALID_BODY, { authorization: 'Bearer k2' });
      assert.equal(res.status, 200);
    });

    test('the Bearer prefix is matched case-insensitively', async () => {
      const res = await app.post('/verify', VALID_BODY, { authorization: 'bearer k1' });
      assert.equal(res.status, 200);
    });

    test('a missing header is rejected with a reason', async () => {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).reason, 'invalid_api_key');
    });

    test('a wrong key is rejected', async () => {
      const res = await app.post('/settle', VALID_BODY, { authorization: 'Bearer nope' });
      assert.equal(res.status, 401);
    });

    test('auth is checked before the body is read', async () => {
      // Otherwise a malformed body from an unauthenticated caller leaks which
      // validation it failed.
      const res = await app.post('/verify', {}, { authorization: 'Bearer nope' });
      assert.equal(res.status, 401);
    });

    test('both /verify and /settle are protected', async () => {
      for (const route of ['/verify', '/settle']) {
        assert.equal((await app.post(route, VALID_BODY)).status, 401, `${route} must require a key`);
      }
    });
  });
});
