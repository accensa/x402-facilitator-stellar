/**
 * CORS: X-Request-Id must stay readable cross-origin (#657).
 *
 * A browser cannot read an unexposed response header, so the id support asks
 * for had to be added to the CORS expose list — alongside the rate-limit
 * headers it precedes. The existing entries must survive the addition, in
 * order, on both a normal response and a preflight.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from './helpers/app.js';

const EXPOSED_HEADERS = [
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
  'EXTENSION-RESPONSES',
  'X-Request-Id',
];

function exposed(res) {
  const raw = res.headers.get('access-control-expose-headers');
  return (raw ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
}

describe('CORS: X-Request-Id exposure (#657)', () => {
  let app;
  before(async () => {
    app = await serve();
  });
  after(() => app.close());

  test('a normal response exposes the rate-limit headers and the request id', async () => {
    const res = await app.get('/supported');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('x-request-id'));
    assert.deepEqual(exposed(res), EXPOSED_HEADERS);
  });

  test('a preflight response exposes the rate-limit headers and the request id', async () => {
    const res = await app.request('/supported', {
      method: 'OPTIONS',
      headers: { origin: 'https://explorer.example.com', 'access-control-request-method': 'GET' },
    });
    assert.equal(res.status, 204);
    assert.deepEqual(exposed(res), EXPOSED_HEADERS);
  });
});
