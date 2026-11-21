/**
 * Issue #665 - OPTIONS preflight for an unknown route must return 404 with public CORS grant.
 *
 * A browser preflight for an unknown or mistyped route (e.g. OPTIONS /verfy)
 * previously fell through to the 404 handler, returning a bare 404 with no CORS
 * grant. This caused browser consoles to report a CORS failure rather than the 404
 * route error. The OPTIONS catch-all attaches the public CORS hook while preserving
 * the 404 route_not_found status and body.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from './helpers/app.js';

const ALLOWED_ORIGIN = 'https://merchant.example.com';

describe('OPTIONS catch-all preflight for unknown routes (#665)', () => {
  test('unknown-path preflight carries public CORS grant with default open configuration', async () => {
    const app = await serve();
    try {
      const res = await app.request('/no-such-route', {
        method: 'OPTIONS',
        headers: { origin: 'https://browser.example.com' },
      });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.match(res.headers.get('vary') ?? '', /\bOrigin\b/);

      const body = await res.json();
      assert.deepEqual(body, { error: 'not_found', reason: 'route_not_found' });
    } finally {
      await app.close();
    }
  });

  test('unknown-path preflight reflects allowlisted origin and denies unlisted origin', async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED_ORIGIN] });
    try {
      // Allowlisted origin gets reflected origin and credentials grant
      const allowedRes = await app.request('/verfy', {
        method: 'OPTIONS',
        headers: { origin: ALLOWED_ORIGIN },
      });
      assert.equal(allowedRes.status, 404);
      assert.equal(allowedRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      assert.equal(allowedRes.headers.get('access-control-allow-credentials'), 'true');
      assert.match(allowedRes.headers.get('vary') ?? '', /\bOrigin\b/);
      assert.deepEqual(await allowedRes.json(), {
        error: 'not_found',
        reason: 'route_not_found',
      });

      // Disallowed origin gets 404 with no ACAO grant
      const deniedRes = await app.request('/verfy', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example.com' },
      });
      assert.equal(deniedRes.status, 404);
      assert.equal(deniedRes.headers.get('access-control-allow-origin'), null);
      assert.match(deniedRes.headers.get('vary') ?? '', /\bOrigin\b/);
      assert.deepEqual(await deniedRes.json(), {
        error: 'not_found',
        reason: 'route_not_found',
      });
    } finally {
      await app.close();
    }
  });

  test('known routes retain their specific OPTIONS preflight handler', async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED_ORIGIN] });
    try {
      // /verify has its own static preflight returning 204
      const verifyRes = await app.request('/verify', {
        method: 'OPTIONS',
        headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
      });
      assert.equal(verifyRes.status, 204);
      assert.equal(verifyRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      const methods = verifyRes.headers.get('access-control-allow-methods') ?? '';
      assert.match(methods, /\bPOST\b/);

      // /supported has public preflight returning 204
      const supportedRes = await app.request('/supported', {
        method: 'OPTIONS',
        headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' },
      });
      assert.equal(supportedRes.status, 204);
      assert.equal(supportedRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    } finally {
      await app.close();
    }
  });

  test('GET on unknown route remains byte-identical with no CORS headers', async () => {
    const app = await serve({ corsAllowedOrigins: [ALLOWED_ORIGIN] });
    try {
      const res = await app.request('/no-such-route', {
        method: 'GET',
        headers: { origin: ALLOWED_ORIGIN },
      });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(await res.json(), { error: 'not_found', reason: 'route_not_found' });
    } finally {
      await app.close();
    }
  });
});
