/**
 * CORS (#76).
 *
 * The policy is decided per route class, so that is what is under test: public
 * reads default open, authenticated routes default closed and only open for an
 * explicitly allowlisted origin. Preflight matters separately because
 * Authorization is not a safelisted request header — every browser call to the
 * payment routes triggers one.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, stubFacilitator, testConfig, TEST_SECRET } from './helpers/app.js';

const ALLOWED = 'https://seller.example.com';

describe('CORS: public reads', () => {
  let app;
  before(async () => {
    app = await serve();
  });
  after(() => app.close());

  test('cross-origin GET is granted with * when no origins are configured', async () => {
    const res = await app.get('/supported', { origin: 'https://explorer.example.com' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('preflight on a read route allows GET', async () => {
    const res = await app.request('/discovery/search?query=x', {
      method: 'OPTIONS',
      headers: { origin: 'https://explorer.example.com', 'access-control-request-method': 'GET' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods'), /GET/);
  });

  test('response headers a client needs are exposed', async () => {
    const res = await app.get('/discovery/search?query=x', {
      origin: 'https://explorer.example.com',
    });
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').split(', ');
    for (const name of [
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
      'EXTENSION-RESPONSES',
    ]) {
      assert.ok(exposed.includes(name), `expected ${name} in Access-Control-Expose-Headers`);
    }
  });
});

describe('CORS: authenticated payment routes', () => {
  test('no grant by default — an unconfigured origin gets no ACAO', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', {}, { origin: 'https://evil.example.com' });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    } finally {
      await app.close();
    }
  });

  test('an allowlisted origin is reflected', async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED] });
    try {
      const res = await app.post('/verify', {}, { origin: ALLOWED });
      assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
    } finally {
      await app.close();
    }
  });

  test('preflight is answered without an API key', async () => {
    // The preflight carries no Authorization header by spec, so it must be
    // answered before auth middleware or it would never get past the browser.
    const app = await serve({ corsAllowedOrigins: [ALLOWED] });
    try {
      const res = await app.request('/verify', {
        method: 'OPTIONS',
        headers: { origin: ALLOWED, 'access-control-request-method': 'POST' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
      const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      assert.ok(allowHeaders.includes('authorization'), 'Authorization must be allowed');
      assert.ok(allowHeaders.includes('content-type'), 'Content-Type must be allowed');
    } finally {
      await app.close();
    }
  });

  test('preflight from a non-allowlisted origin answers without ACAO', async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED] });
    try {
      const res = await app.request('/settle', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example.com' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    } finally {
      await app.close();
    }
  });

  test('a configured allowlist also narrows the public reads', async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED] });
    try {
      const granted = await app.get('/supported', { origin: ALLOWED });
      assert.equal(granted.headers.get('access-control-allow-origin'), ALLOWED);

      const denied = await app.get('/supported', { origin: 'https://other.example.com' });
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    } finally {
      await app.close();
    }
  });

  test('manual cataloguing POST follows the authenticated policy', async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED] });
    try {
      const res = await app.request('/discovery/resources', {
        method: 'OPTIONS',
        headers: { origin: ALLOWED },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
      assert.doesNotMatch(res.headers.get('access-control-allow-methods') ?? '', /GET/);
    } finally {
      await app.close();
    }
  });

  test('the facilitator is never consulted by a preflight', async () => {
    const facilitator = stubFacilitator();
    const app = await serve({ corsAllowedOrigins: [ALLOWED], facilitator });
    try {
      await app.request('/verify', {
        method: 'OPTIONS',
        headers: { origin: ALLOWED },
      });
      assert.equal(facilitator.calls.length, 0);
    } finally {
      await app.close();
    }
  });
});

describe('CORS: GET /usage and the settlement reads', () => {
  // The three routes the authenticated policy claims to cover but which had no
  // OPTIONS route: a browser preflighting any of them fell through to the 404
  // handler, so the caller saw a missing route instead of a CORS verdict.
  const AFFECTED = ['/usage', '/settlements/idem-1', '/settlements/idem-1/events'];

  test("an allowlisted origin's preflight answers 204 and names the served methods", async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED] });
    try {
      for (const path of AFFECTED) {
        const res = await app.request(path, {
          method: 'OPTIONS',
          headers: { origin: ALLOWED, 'access-control-request-method': 'GET' },
        });
        assert.equal(res.status, 204, path);
        assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED, path);

        // The verb list must name what the route actually serves — GET — and
        // must not borrow POST from the authenticated class default.
        const methods = res.headers.get('access-control-allow-methods') ?? '';
        assert.match(methods, /\bGET\b/, `${path}: ${methods}`);
        assert.match(methods, /\bOPTIONS\b/, `${path}: ${methods}`);
        assert.doesNotMatch(methods, /\bPOST\b/, `${path}: ${methods}`);

        // Authorization is what forces the preflight in the first place, so
        // the answer has to permit it.
        const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
        assert.ok(allowHeaders.includes('authorization'), path);
      }
    } finally {
      await app.close();
    }
  });

  test('an unlisted origin gets 204 with no ACAO — never a 404', async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED] });
    try {
      for (const path of AFFECTED) {
        const res = await app.request(path, {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
        });
        assert.equal(
          res.status,
          204,
          `${path}: a denied preflight must be answered by the OPTIONS route, not the 404 handler`,
        );
        assert.equal(res.headers.get('access-control-allow-origin'), null, path);
      }
    } finally {
      await app.close();
    }
  });

  test('a real cross-origin GET /usage reflects the allowlisted origin', async () => {
    const app = await serve({
      config: testConfig({
        apiKeys: [`admin:${TEST_SECRET}`],
        corsAllowedOrigins: [ALLOWED],
      }),
    });
    try {
      const granted = await app.get('/usage', {
        origin: ALLOWED,
        authorization: `Bearer ${TEST_SECRET}`,
      });
      assert.equal(granted.status, 200);
      assert.equal(granted.headers.get('access-control-allow-origin'), ALLOWED);

      const denied = await app.get('/usage', {
        origin: 'https://evil.example.com',
        authorization: `Bearer ${TEST_SECRET}`,
      });
      assert.equal(denied.status, 200);
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    } finally {
      await app.close();
    }
  });
});

describe('CORS: merchant domain patterns (#414)', () => {
  // CORS_ALLOWED_ORIGINS entries are compiled to anchored regexes, so one
  // entry can cover a merchant's whole subdomain tree instead of listing
  // every host by hand.
  const SUBDOMAINS = 'https://.*\\.merchant\\.example\\.com';

  test('an origin matching a configured pattern is reflected verbatim', async () => {
    const app = await serve({ corsAllowedOrigins: [SUBDOMAINS] });
    try {
      for (const origin of [
        'https://shop.merchant.example.com',
        'https://pay.merchant.example.com',
      ]) {
        const res = await app.post('/verify', {}, { origin });
        assert.equal(res.headers.get('access-control-allow-origin'), origin, origin);
        // A concrete reflection may carry credentials; a wildcard never could.
        assert.equal(res.headers.get('access-control-allow-credentials'), 'true', origin);
      }
    } finally {
      await app.close();
    }
  });

  test('an origin outside every pattern gets no grant', async () => {
    const app = await serve({ corsAllowedOrigins: [SUBDOMAINS] });
    try {
      for (const origin of [
        'https://evil.example.com',
        // The suffix a merely-*containing* pattern would have admitted: the
        // anchoring is what refuses it.
        'https://merchant.example.com.evil.net',
      ]) {
        const res = await app.post('/verify', {}, { origin });
        assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
      }
    } finally {
      await app.close();
    }
  });

  test('a bare domain pattern matches the origin host on label boundaries only', async () => {
    // A merchant configures its domain without the scheme it never wrote.
    const app = await serve({ corsAllowedOrigins: ['seller\\.example\\.com'] });
    try {
      const granted = await app.post('/verify', {}, { origin: 'https://seller.example.com' });
      assert.equal(
        granted.headers.get('access-control-allow-origin'),
        'https://seller.example.com',
      );

      // A lookalike that merely ends the same way is not the merchant: the
      // pattern is matched against dot-aligned suffixes of the host, never
      // against an unlabelled tail like `badexample.com`.
      for (const origin of ['https://badexample.com', 'https://evil.example.net']) {
        const denied = await app.post('/verify', {}, { origin });
        assert.equal(denied.headers.get('access-control-allow-origin'), null, origin);
      }
    } finally {
      await app.close();
    }
  });

  test('a request with no Origin header gets no grant on either class', async () => {
    const app = await serve({ corsAllowedOrigins: [SUBDOMAINS] });
    try {
      const authed = await app.post('/verify', {});
      assert.equal(authed.headers.get('access-control-allow-origin'), null);

      // Public reads fall back to `*` only when no allowlist exists; a
      // configured policy grants nothing to a request that stated no origin.
      const pub = await app.get('/supported');
      assert.equal(pub.headers.get('access-control-allow-origin'), null);
    } finally {
      await app.close();
    }
  });

  test('preflight caches for 24h and permits exactly the required x402 headers', async () => {
    const app = await serve({ corsAllowedOrigins: [SUBDOMAINS] });
    try {
      const res = await app.request('/verify', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://shop.merchant.example.com',
          'access-control-request-method': 'POST',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(
        res.headers.get('access-control-allow-origin'),
        'https://shop.merchant.example.com',
      );
      assert.equal(res.headers.get('access-control-max-age'), '86400');

      const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '')
        .split(', ')
        .map(name => name.toLowerCase());
      // Exactly the required set — nothing a browser may send is advertised
      // beyond it.
      assert.deepEqual(allowHeaders.sort(), ['authorization', 'content-type', 'x-402-payment']);
    } finally {
      await app.close();
    }
  });

  test('a wildcard grant still pairs with no credentials header', async () => {
    const app = await serve();
    try {
      const res = await app.get('/supported', { origin: 'https://explorer.example.com' });
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
    } finally {
      await app.close();
    }
  });

  test('a pattern that is not a valid regex refuses to boot, naming the entry', async () => {
    await assert.rejects(
      () => serve({ corsAllowedOrigins: ['https://[broken'] }),
      /CORS_ALLOWED_ORIGINS entry "https:\/\/\[broken" is not a valid regular expression/,
      'a malformed allowlist entry must fail at construction, not at first use',
    );
  });
});
