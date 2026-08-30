/**
 * http-surface-audit.test.js — Issue #143: audit the HTTP surface against the
 * x402 spec with a real client.
 *
 * The unit suite is solid at the handler level, but nothing exercises the
 * surface the way an external integrator does: real HTTP, real headers, real
 * error bodies, from OUTSIDE the process. `serve()` binds an ephemeral port
 * and drives every request through `fetch`, so each request here crosses the
 * network boundary rather than going through an in-process test helper.
 *
 * This file is a systematic pass over every route and every documented failure
 * mode. It records route, input, expected, observed and verdict in
 * docs/HTTP-SURFACE-AUDIT.md (the committed deliverable); the assertions here
 * pin the wire behaviour so a regression cannot silently drift from that
 * table. The pass deliberately includes the hostile/careless client cases the
 * happy path never sees: malformed JSON, oversized bodies, wrong content
 * types, missing headers, duplicated query parameters, absurd pagination and
 * unicode/injection-shaped query filters.
 *
 * Two unambiguous defects found by this pass were fixed in src/app.js and are
 * pinned here:
 *   - malformed JSON surfaced `internal_error` instead of the documented
 *     `malformed_json` reason code (Fastify 5 renamed the parser error);
 *   - a malformed discovery extension made `processCataloging` throw, which was
 *     swallowed, so the EXTENSION-RESPONSES header was omitted entirely.
 * They are deferred only where noted so the fix list and the evidence stay in
 * one place.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, stubRateLimiter, stubCatalog, testConfig, VALID_BODY } from './helpers/app.js';
import { RateLimiter } from '../src/rate-limit.js';

/** base64-decode the EXTENSION-RESPONSES envelope into a plain object. */
function decodeExtension(header) {
  assert.ok(header, 'EXTENSION-RESPONSES header must be present');
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.ok(decoded && typeof decoded.bazaar === 'object', 'must decode to { bazaar: ... }');
  return decoded.bazaar;
}

/**
 * A payment body carrying a valid Bazaar discovery extension, so automatic
 * cataloging is attempted. `extension` overrides the bazaar block.
 */
function discoveryBody(extension) {
  return {
    paymentPayload: {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: extension ?? {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: 'stellar:testnet',
      payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
      asset: 'USDC',
      maxAmountRequired: '1',
    },
  };
}

const AUTH = { authorization: 'Bearer secret' };
const KEEP_ALIVE = { keepalive: false };

/**
 * The helper's default catalog stub targets listResources only; the discovery
 * surface also needs `search`. This returns a catalog that serves both reads
 * with fixed, inspectable results so the search routes can be exercised.
 */
function auditCatalog() {
  return {
    ...stubCatalog({ upsertResource: async (resource, source) => ({ ...resource, source }) }),
    listResources: async () => ({ items: [], total: 0 }),
    search: async params => ({
      resources: [],
      partialResults: true,
      pagination: { limit: params.limit ?? 20, cursor: null },
    }),
  };
}

describe('HTTP surface audit: route inventory (every registered route)', () => {
  test('GET /healthz answers 200 JSON on the operational route', async () => {
    const app = await serve();
    try {
      const res = await app.get('/healthz');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      await app.close();
    }
  });

  test('GET /readyz reports not_ready 503 when no readiness is configured', async () => {
    const app = await serve();
    try {
      const res = await app.get('/readyz');
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.status, 'not_ready');
      assert.equal(body.reason, 'readiness_not_configured');
      assert.ok(body.ok === false);
    } finally {
      await app.close();
    }
  });

  test('GET /supported is a public JSON read with no auth and no rate-limit headers', async () => {
    // Public reads deliberately carry no API key and no rate-limit contract.
    const app = await serve();
    try {
      const res = await app.get('/supported');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.ok(Array.isArray(body.kinds));
      assert.ok(Array.isArray(body.extensions));
      assert.equal(res.headers.get('ratelimit-limit'), null);
    } finally {
      await app.close();
    }
  });

  test('GET /metrics is Prometheus text, not JSON', async () => {
    const app = await serve();
    try {
      const res = await app.get('/metrics');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    } finally {
      await app.close();
    }
  });

  test('GET /usage refuses in open mode and requires a valid API key', async () => {
    // No API keys configured -> usage is forbidden even in /verify open mode.
    const noKeys = await serve({ config: testConfig({}) });
    try {
      const res = await noKeys.get('/usage');
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.invalidReason, 'open_mode_usage_forbidden');
    } finally {
      await noKeys.close();
    }

    const app = await serve({ config: testConfig({ apiKeys: ['test:secret'] }) });
    try {
      const bad = await app.get('/usage', { authorization: 'Bearer wrong' });
      assert.equal(bad.status, 401);
      assert.equal((await bad.json()).invalidReason, 'invalid_api_key');
      const ok = await app.get('/usage', AUTH);
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get('content-type') ?? '', /application\/json/);
      const usage = await ok.json();
      assert.equal(usage.keyId, 'test'.toUpperCase());
    } finally {
      await app.close();
    }
  });

  test('unknown routes 404 with a JSON reason, never HTML', async () => {
    const app = await serve();
    try {
      const res = await app.get('/does-not-exist');
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await res.json(), { error: 'not_found', reason: 'route_not_found' });
    } finally {
      await app.close();
    }
  });

  test('every payment route preflight answers 204 with CORS allow headers', async () => {
    const app = await serve();
    try {
      for (const path of [
        '/verify',
        '/settle',
        '/discovery/resources',
        '/supported',
        '/discovery/search',
      ]) {
        const res = await app.request(path, { method: 'OPTIONS', ...KEEP_ALIVE });
        assert.equal(res.status, 204, `${path} preflight must be 204`);
        const allow = res.headers.get('access-control-allow-headers') ?? '';
        assert.match(allow.toLowerCase(), /content-type/);
      }
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: /verify', () => {
  test('a valid body verifies, returns 200 JSON, and carries RateLimit headers', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(body.isValid, true);
      assert.equal(res.headers.get('ratelimit-limit'), '60');
      assert.equal(res.headers.get('ratelimit-remaining'), '59');
      assert.ok(res.headers.get('ratelimit-reset'));
    } finally {
      await app.close();
    }
  });

  test('malformed JSON is 400 JSON with the malformed_json reason, not HTML', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', '{"paymentPayload": broken', AUTH);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(body.isValid, false);
      // Fixed in this pass (#143): was `internal_error` because Fastify 5
      // renames the parser error to FST_ERR_CTP_INVALID_JSON_BODY.
      assert.equal(body.invalidReason, 'malformed_json');
      assert.ok(!JSON.stringify(body).includes('at '), 'must not leak a stack trace');
    } finally {
      await app.close();
    }
  });

  test('an oversized body is 413 with the payload_too_large reason', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', JSON.stringify({ pad: 'x'.repeat(300 * 1024) }), AUTH);
      assert.equal(res.status, 413);
      const body = await res.json();
      assert.equal(body.invalidReason, 'payload_too_large');
    } finally {
      await app.close();
    }
  });

  test('a structurally missing field is 400 with invalid_request, not a 500', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', JSON.stringify({ paymentPayload: {} }), AUTH);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'invalid_request');
    } finally {
      await app.close();
    }
  });

  test('an unsupported network is 400 with unsupported_network', async () => {
    const app = await serve();
    try {
      const res = await app.post(
        '/verify',
        JSON.stringify({
          paymentPayload: {},
          paymentRequirements: { scheme: 'exact', network: 'stellar:nowhere' },
        }),
        AUTH,
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.invalidReason, 'unsupported_network');
    } finally {
      await app.close();
    }
  });

  test('an unauthenticated verify in keyed mode is 401, never 500', async () => {
    const app = await serve({ config: testConfig({ apiKeys: ['test:secret'] }) });
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).invalidReason, 'missing_auth_header');
    } finally {
      await app.close();
    }
  });

  test('a rate-limited /verify is 429 with Retry-After and a reason', async () => {
    const app = await serve({ rateLimiter: stubRateLimiter({ allow: false }) });
    try {
      const res = await app.post('/verify', VALID_BODY);
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.ok(res.headers.get('ratelimit-remaining') === '0');
      assert.equal((await res.json()).invalidReason, 'rate_limited');
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: RateLimit-Remaining decrements (not off by one)', () => {
  test('consecutive allowed verifies report remaining as limit minus requests consumed', async () => {
    // Issue #143 hypothesised an off-by-one here by reading the code; this
    // proves the wire behaviour is correct: request 1 shows 99 (100-1), and
    // each further request decrements by exactly one, never below the true
    // remaining after the request has been counted.
    const rateLimiter = new RateLimiter({
      global: { verifyRpm: 100, settleRpm: 100, settleRph: 100, settleRpd: 100, feeSpd: 1000000 },
      keys: {},
    });
    const app = await serve({
      config: testConfig({ apiKeys: ['test:secret'] }),
      rateLimiter,
    });
    try {
      const seen = [];
      for (let i = 0; i < 5; i++) {
        const res = await app.post('/verify', VALID_BODY, AUTH);
        assert.equal(res.status, 200);
        seen.push(Number(res.headers.get('ratelimit-remaining')));
      }
      assert.deepEqual(seen, [99, 98, 97, 96, 95]);
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: /settle', () => {
  test('a valid settle returns 200 with a settle-shaped body and RateLimit headers', async () => {
    const app = await serve();
    try {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(body.transaction);
      assert.equal(res.headers.get('ratelimit-limit'), '60');
      assert.ok(Number.isInteger(Number(res.headers.get('ratelimit-remaining'))));
    } finally {
      await app.close();
    }
  });

  test('malformed JSON is 400 JSON with malformed_json, in the settle shape', async () => {
    const app = await serve();
    try {
      const res = await app.post('/settle', '{"paymentPayload": broken', AUTH);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.errorReason, 'malformed_json');
      assert.equal(typeof body.transaction, 'string');
      assert.equal(body.network, undefined);
    } finally {
      await app.close();
    }
  });

  test('a settle with no discovery extension still returns a valid success body', async () => {
    const app = await serve();
    try {
      const res = await app.post('/settle', VALID_BODY);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).success, true);
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: EXTENSION-RESPONSES for all four cataloging outcomes', () => {
  test('landed cataloging decodes to { status: landed, code: catalog_success }', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.post('/verify', discoveryBody(), AUTH);
      // Cataloging is enqueued off the hot path, so give it a tick to settle.
      await new Promise(r => setTimeout(r, 20));
      assert.equal(res.status, 200);
      const bazaar = decodeExtension(res.headers.get('EXTENSION-RESPONSES'));
      assert.equal(bazaar.status, 'landed');
      assert.equal(bazaar.code, 'catalog_success');
    } finally {
      await app.close();
    }
  });

  test('rejected cataloging (rate limited) decodes to { status: rejected, code: catalog_rate_limited }', async () => {
    // The real limiter with catalogRpm:0 lets verify pass but refuses the
    // automatic catalog write, which maps to the `rejected` outcome.
    const rateLimiter = new RateLimiter({
      global: {
        verifyRpm: 100,
        settleRpm: 100,
        settleRph: 100,
        settleRpd: 100,
        feeSpd: 1000000,
        catalogRpm: 0,
        catalogReadRpm: 100,
      },
      keys: {},
    });
    const app = await serve({
      config: testConfig({ apiKeys: ['test:secret'] }),
      rateLimiter,
      catalog: stubCatalog(),
    });
    try {
      const res = await app.post('/verify', discoveryBody(), AUTH);
      await new Promise(r => setTimeout(r, 20));
      assert.equal(res.status, 200);
      const bazaar = decodeExtension(res.headers.get('EXTENSION-RESPONSES'));
      assert.equal(bazaar.status, 'rejected');
      assert.equal(bazaar.code, 'catalog_rate_limited');
    } finally {
      await app.close();
    }
  });

  test('rejected cataloging (hostile routeTemplate) decodes to an explicit reason', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.post(
        '/verify',
        discoveryBody({
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: 'http://evil',
        }),
        AUTH,
      );
      await new Promise(r => setTimeout(r, 20));
      const bazaar = decodeExtension(res.headers.get('EXTENSION-RESPONSES'));
      assert.equal(bazaar.status, 'rejected');
      assert.equal(bazaar.code, 'invalid_routeTemplate');
    } finally {
      await app.close();
    }
  });

  test('partially landed cataloging (bad iconUrl) decodes to { status: partially landed }', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.post(
        '/verify',
        {
          ...discoveryBody(),
          paymentPayload: {
            ...discoveryBody().paymentPayload,
            resource: { ...discoveryBody().paymentPayload.resource, iconUrl: 'not-a-valid-url' },
          },
        },
        AUTH,
      );
      await new Promise(r => setTimeout(r, 20));
      const bazaar = decodeExtension(res.headers.get('EXTENSION-RESPONSES'));
      assert.equal(bazaar.status, 'partially landed');
      assert.equal(bazaar.code, 'catalog_partial');
      assert.match(bazaar.reason ?? '', /iconUrl/);
    } finally {
      await app.close();
    }
  });

  test('not attempted cataloging decodes to { status: not attempted }', async () => {
    // No discovery extension -> nothing was attempted, and the header is still
    // returned so the caller is not left guessing.
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.post('/verify', VALID_BODY, AUTH);
      await new Promise(r => setTimeout(r, 20));
      assert.equal(res.status, 200);
      const bazaar = decodeExtension(res.headers.get('EXTENSION-RESPONSES'));
      assert.equal(bazaar.status, 'not attempted');
    } finally {
      await app.close();
    }
  });

  test('a malformed discovery extension still returns an EXTENSION-RESPONSES header', async () => {
    // Fixed in this pass (#143): a malformed bazaar block used to make
    // processCataloging throw and silently drop the header entirely.
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.post(
        '/verify',
        discoveryBody({ info: 'bad', schema: { type: 'object' }, routeTemplate: '/a' }),
        AUTH,
      );
      await new Promise(r => setTimeout(r, 20));
      assert.equal(res.status, 200);
      const bazaar = decodeExtension(res.headers.get('EXTENSION-RESPONSES'));
      assert.equal(bazaar.status, 'not attempted');
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: POST /discovery/resources (manual cataloguing)', () => {
  test('a valid manual registration returns 200 with the stored resource', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.post('/discovery/resources', discoveryBody(), AUTH);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.ok(body.resource);
    } finally {
      await app.close();
    }
  });

  test('malformed JSON returns 400 JSON, never HTML', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.post('/discovery/resources', '{"broken', AUTH);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.equal((await res.json()).error, 'malformed_json');
    } finally {
      await app.close();
    }
  });

  test('an unauthenticated manual registration is 401', async () => {
    const app = await serve({
      config: testConfig({ apiKeys: ['test:secret'] }),
      catalog: stubCatalog(),
    });
    try {
      const res = await app.post('/discovery/resources', discoveryBody());
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: GET /discovery/resources (public read)', () => {
  test('a normal read returns a discovery-shaped JSON body', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.get('/discovery/resources');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(body.x402Version, 2);
      assert.ok(Array.isArray(body.items));
      assert.equal(body.pagination.limit, 20);
      assert.equal(body.pagination.offset, 0);
    } finally {
      await app.close();
    }
  });

  test('absurd pagination is clamped: limit 500 -> 100, offset -5 -> 0', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.get('/discovery/resources?limit=500&offset=-5');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.pagination.limit, 100);
      assert.equal(body.pagination.offset, 0);
    } finally {
      await app.close();
    }
  });

  test('non-numeric pagination falls back to the defaults', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.get('/discovery/resources?limit=abc');
      const body = await res.json();
      assert.equal(body.pagination.limit, 20);
      assert.equal(body.pagination.offset, 0);
    } finally {
      await app.close();
    }
  });

  test('duplicated query parameters are tolerated and do not error', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const res = await app.get('/discovery/resources?limit=1&limit=500');
      assert.equal(res.status, 200);
      // Fastify coalesces a duplicated scalar to its first value here.
      assert.equal((await res.json()).pagination.limit, 1);
    } finally {
      await app.close();
    }
  });

  test('unicode and injection-shaped query filters return an empty result, never an error', async () => {
    const app = await serve({ catalog: stubCatalog() });
    try {
      const q = `?payTo=${encodeURIComponent("' OR 1=1--")}&extensions=${encodeURIComponent('<script>alert(1)</script>')}&scheme=${encodeURIComponent('exact<>')}`;
      const res = await app.get(`/discovery/resources${q}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.items));
      assert.equal(body.items.length, 0);
    } finally {
      await app.close();
    }
  });

  test('a rate-limited read is 429 with Retry-After and a reason', async () => {
    const app = await serve({ rateLimiter: stubRateLimiter({ allow: false }) });
    try {
      const res = await app.get('/discovery/resources');
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal((await res.json()).invalidReason, 'rate_limited');
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: GET /discovery/search', () => {
  test('a missing query is 400 with query is required', async () => {
    const app = await serve({ catalog: auditCatalog() });
    try {
      const res = await app.get('/discovery/search');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'invalid_request');
      assert.equal(body.reason, 'query is required');
    } finally {
      await app.close();
    }
  });

  test('a search returns a discovery-shaped response with the query intact', async () => {
    const app = await serve({ catalog: auditCatalog() });
    try {
      const res = await app.get('/discovery/search?query=hello');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.x402Version, 2);
      assert.ok(Array.isArray(body.resources));
      // Recorded as a finding: search pagination reports { limit, cursor },
      // not the { limit, offset, total } that /discovery/resources reports.
      assert.ok(body.pagination);
      assert.equal(body.pagination.limit, 20);
    } finally {
      await app.close();
    }
  });

  test('absurd search limit is clamped to 100', async () => {
    const app = await serve({ catalog: auditCatalog() });
    try {
      const res = await app.get('/discovery/search?query=hello&limit=500');
      const body = await res.json();
      assert.equal(body.pagination.limit, 100);
    } finally {
      await app.close();
    }
  });

  test('unicode and injection-shaped search queries are tolerated', async () => {
    const app = await serve({ catalog: auditCatalog() });
    try {
      const q = `?query=${encodeURIComponent("hello <img src=x> ' OR 1=1 -- 你好")}`;
      const res = await app.get(`/discovery/search${q}`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray((await res.json()).resources));
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: settlement status reads', () => {
  test('GET /settlements/:key for an unknown key is 404 JSON', async () => {
    const app = await serve({
      config: testConfig({ apiKeys: ['test:secret'] }),
      settlementStore: undefined,
    });
    try {
      const res = await app.get('/settlements/does-not-exist', AUTH);
      // Without a durable settlement store the read path 404s.
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.equal((await res.json()).error, 'not_found');
    } finally {
      await app.close();
    }
  });

  test('settlement reads require an API key', async () => {
    const app = await serve({ config: testConfig({ apiKeys: ['test:secret'] }) });
    try {
      const res = await app.get('/settlements/any', {});
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });

  test('the events sub-route is routed and 404s for an unknown key', async () => {
    const app = await serve({ config: testConfig({ apiKeys: ['test:secret'] }) });
    try {
      const res = await app.get('/settlements/does-not-exist/events', AUTH);
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    } finally {
      await app.close();
    }
  });
});

describe('HTTP surface audit: headers carry their contracts', () => {
  test('every JSON response advertises application/json, never text/html', async () => {
    const app = await serve({
      config: testConfig({ apiKeys: ['test:secret'] }),
      catalog: auditCatalog(),
    });
    try {
      const paths = [
        { method: 'GET', path: '/supported' },
        { method: 'GET', path: '/discovery/resources' },
        { method: 'GET', path: '/discovery/search?query=x' },
        { method: 'GET', path: '/usage', headers: AUTH },
        { method: 'GET', path: '/healthz' },
        { method: 'POST', path: '/verify', headers: AUTH, body: VALID_BODY },
        { method: 'POST', path: '/settle', headers: AUTH, body: VALID_BODY },
      ];
      for (const req of paths) {
        const res = await app.request(req.path, {
          method: req.method,
          headers: { 'content-type': 'application/json', ...(req.headers ?? {}) },
          body: req.body ? JSON.stringify(req.body) : undefined,
          ...KEEP_ALIVE,
        });
        assert.equal(res.status, 200, `${req.method} ${req.path}`);
        const ct = (res.headers.get('content-type') ?? '').toLowerCase();
        assert.ok(
          ct.includes('application/json'),
          `${req.method} ${req.path} content-type was "${ct}"`,
        );
      }
    } finally {
      await app.close();
    }
  });

  test('Access-Control-Expose-Headers names the read-worthy headers on public reads', async () => {
    const app = await serve({ corsAllowedOrigins: ['https://good.example'] });
    try {
      const res = await app.request('/supported', {
        headers: { origin: 'https://good.example' },
        ...KEEP_ALIVE,
      });
      assert.equal(res.status, 200);
      const exposed = res.headers.get('access-control-expose-headers') ?? '';
      for (const h of [
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
        'EXTENSION-RESPONSES',
      ]) {
        assert.ok(exposed.includes(h), `Access-Control-Expose-Headers must include ${h}`);
      }
    } finally {
      await app.close();
    }
  });
});
