/**
 * The single-resource routes (#222, #221).
 *
 * `getResource` and `deleteResource` existed on the store but were reachable
 * from tests only: a caller who knew a listing's URL had to page the whole
 * catalog to find it, and nobody could take a listing down at all. These tests
 * pin the two routes that expose them — found by URL, with an optional toolName
 * to disambiguate two tools sharing one URL.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serve,
  stubCatalog,
  stubRateLimiter,
  testConfig,
  TEST_SECRET,
  captureAudit,
} from './helpers/app.js';

const ENTRY = {
  url: 'http://api.example/paid',
  serviceName: 'weather',
  payTo: 'GPAYTO',
  source: 'settle',
  provisional: false,
};

/** A catalog that answers point reads and records deletions. */
function pointCatalog({ entry = ENTRY, deleteResult, onDelete } = {}) {
  const deleted = [];
  return {
    deleted,
    catalog: stubCatalog({
      getResource: async (url, toolName) =>
        entry && url === entry.url && (toolName == null || toolName === entry.toolName)
          ? entry
          : null,
      deleteResource: async (url, toolName) => {
        if (onDelete) return onDelete(url, toolName);
        deleted.push({ url, toolName });
        return deleteResult ?? { removed: true, resource: { ...entry, url, toolName } };
      },
    }),
  };
}

const AUTH = { authorization: `Bearer ${TEST_SECRET}` };

describe('GET /discovery/resource (#222)', () => {
  test('returns the listing named by the url query parameter', async () => {
    const { catalog } = pointCatalog();
    const app = await serve({ catalog });
    try {
      const res = await app.get(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.x402Version, 2);
      assert.equal(body.resource.url, ENTRY.url);
      assert.equal(body.resource.serviceName, 'weather');
    } finally {
      await app.close();
    }
  });

  test('is a public read: no API key, no rate-limit contract', async () => {
    const { catalog } = pointCatalog();
    const app = await serve({ catalog, config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }) });
    try {
      const res = await app.get(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`);
      assert.equal(res.status, 200, 'the read must not require a key');
    } finally {
      await app.close();
    }
  });

  test('passes toolName through, so two tools on one URL stay distinct', async () => {
    const seen = [];
    const catalog = stubCatalog({
      getResource: async (url, toolName) => {
        seen.push({ url, toolName });
        return null;
      },
    });
    const app = await serve({ catalog });
    try {
      const res = await app.get(
        `/discovery/resource?url=${encodeURIComponent(ENTRY.url)}&toolName=forecast`,
      );
      assert.equal(res.status, 404);
      assert.deepEqual(seen, [{ url: ENTRY.url, toolName: 'forecast' }]);
    } finally {
      await app.close();
    }
  });

  test('a missing url is a 400, not a lookup of the empty string', async () => {
    const { catalog } = pointCatalog();
    const app = await serve({ catalog });
    try {
      const res = await app.get('/discovery/resource');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.reason, 'url is required');
    } finally {
      await app.close();
    }
  });

  test('an unknown url is a 404 with reason resource_not_found', async () => {
    const { catalog } = pointCatalog({ entry: null });
    const app = await serve({ catalog });
    try {
      const res = await app.get('/discovery/resource?url=http://nope.example/x');
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, 'not_found');
      assert.equal(body.reason, 'resource_not_found');
    } finally {
      await app.close();
    }
  });

  test('the 404 carries no cache headers, so a proxy cannot cache "does not exist"', async () => {
    // A cached 404 would outlive the seller's registration: they publish the
    // resource, and for the whole max-age every reader is told it is not there.
    const { catalog } = pointCatalog({ entry: null });
    const app = await serve({ catalog });
    try {
      const res = await app.get('/discovery/resource?url=http://nope.example/x');
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), null);
      assert.equal(res.headers.get('etag'), null);
    } finally {
      await app.close();
    }
  });

  test('sends caching validators, and a matching If-None-Match is a body-less 304', async () => {
    // The point read is polled like the listing, so an unchanged poll must cost
    // a header comparison rather than a catalog lookup (#200).
    const { catalog } = pointCatalog();
    const app = await serve({ catalog });
    try {
      const first = await app.get(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`);
      assert.equal(first.status, 200);
      const etag = first.headers.get('etag');
      assert.ok(etag, 'the response must carry an ETag');
      assert.ok(first.headers.get('cache-control'));

      const second = await app.get(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`, {
        'if-none-match': etag,
      });
      assert.equal(second.status, 304);
    } finally {
      await app.close();
    }
  });

  test('a store failure is a 500 that leaks no internals', async () => {
    const catalog = stubCatalog({
      getResource: async () => {
        throw new Error('catalog exploded at /srv/app/src/catalog/memory.js:41');
      },
    });
    const app = await serve({ catalog });
    try {
      const res = await app.get(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'internal_error');
      assert.ok(!/memory\.js/.test(JSON.stringify(body)));
    } finally {
      await app.close();
    }
  });

  test('the read is metered through the catalog-read bucket', async () => {
    const rateLimiter = stubRateLimiter();
    const { catalog } = pointCatalog();
    const app = await serve({ catalog, rateLimiter });
    try {
      await app.get(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`);
      assert.ok(rateLimiter.recorded.some(r => r.name === 'recordCatalogRead'));
    } finally {
      await app.close();
    }
  });
});

describe('DELETE /discovery/resource (#221)', () => {
  test('requires an API key when keys are configured', async () => {
    const { catalog, deleted } = pointCatalog();
    const app = await serve({ catalog, config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }) });
    try {
      const res = await app.request(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`, {
        method: 'DELETE',
      });
      assert.equal(res.status, 401);
      assert.equal(deleted.length, 0, 'an unauthenticated delete must not reach the store');
    } finally {
      await app.close();
    }
  });

  test('removes the listing and reports what went', async () => {
    const { catalog, deleted } = pointCatalog();
    const app = await serve({ catalog, config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }) });
    try {
      const res = await app.request(
        `/discovery/resource?url=${encodeURIComponent(ENTRY.url)}&toolName=forecast`,
        { method: 'DELETE', headers: AUTH },
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.removed.url, ENTRY.url);
      assert.equal(body.removed.toolName, 'forecast');
      assert.deepEqual(deleted, [{ url: ENTRY.url, toolName: 'forecast' }]);
    } finally {
      await app.close();
    }
  });

  test('audits the removal with the actor and the target', async () => {
    const { audit, records } = captureAudit();
    const { catalog } = pointCatalog();
    const app = await serve({
      catalog,
      config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }),
      extras: { audit },
    });
    try {
      await app.request(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      const event = records.find(r => r.event === 'catalog_delete');
      assert.ok(
        event,
        'a deletion must be auditable — the catalog went from append-only to erasable',
      );
      assert.equal(event.actor, 'ADMIN');
      assert.equal(event.url, ENTRY.url);
    } finally {
      await app.close();
    }
  });

  test('a listing that is not there is a 404, not a silent success', async () => {
    const { catalog } = pointCatalog({
      deleteResult: { removed: false, resource: null },
    });
    const app = await serve({ catalog, config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }) });
    try {
      const res = await app.request(`/discovery/resource?url=http://nope.example/x`, {
        method: 'DELETE',
        headers: AUTH,
      });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).reason, 'resource_not_found');
    } finally {
      await app.close();
    }
  });

  test('a missing url is a 400', async () => {
    const { catalog, deleted } = pointCatalog();
    const app = await serve({ catalog, config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }) });
    try {
      const res = await app.request('/discovery/resource', { method: 'DELETE', headers: AUTH });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, 'url is required');
      assert.equal(deleted.length, 0);
    } finally {
      await app.close();
    }
  });

  test('a failed durable delete is a 500 carrying the store code', async () => {
    const failure = Object.assign(new Error('could not remove'), {
      code: 'catalog_delete_failed',
    });
    const { catalog } = pointCatalog({
      onDelete: () => {
        throw failure;
      },
    });
    const app = await serve({ catalog, config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }) });
    try {
      const res = await app.request(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'catalog_error');
      assert.equal(body.reason, 'catalog_delete_failed');
    } finally {
      await app.close();
    }
  });

  test('a removal broadcasts a cache invalidation to peers', async () => {
    const invalidations = [];
    const catalog = stubCatalog({
      deleteResource: async () => ({ removed: true, resource: ENTRY }),
      searchCache: {
        invalidate: async detail => invalidations.push(detail),
      },
    });
    const app = await serve({ catalog, config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }) });
    try {
      await app.request(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      assert.deepEqual(invalidations, [{ reason: 'cataloging:delete' }]);
    } finally {
      await app.close();
    }
  });

  test('the removal is metered through the catalog-write bucket', async () => {
    const rateLimiter = stubRateLimiter();
    const { catalog } = pointCatalog();
    const app = await serve({
      catalog,
      rateLimiter,
      config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }),
    });
    try {
      await app.request(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      assert.ok(rateLimiter.recorded.some(r => r.name === 'recordCatalog'));
    } finally {
      await app.close();
    }
  });

  test('a refusal is a 429 before the store is touched', async () => {
    const rateLimiter = stubRateLimiter({ allow: false, reason: 'catalog_rpm_exceeded' });
    const { catalog, deleted } = pointCatalog();
    const app = await serve({
      catalog,
      rateLimiter,
      config: testConfig({ apiKeys: [`admin:${TEST_SECRET}`] }),
    });
    try {
      const res = await app.request(`/discovery/resource?url=${encodeURIComponent(ENTRY.url)}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      assert.equal(res.status, 429);
      assert.equal(deleted.length, 0);
    } finally {
      await app.close();
    }
  });
});

describe('CORS posture for the single-resource routes', () => {
  test('an allowlisted origin may preflight the DELETE, and is told both verbs', async () => {
    const { catalog } = pointCatalog();
    const app = await serve({ catalog, corsAllowedOrigins: ['https://app.example'] });
    try {
      const res = await app.request('/discovery/resource', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example',
          'access-control-request-method': 'DELETE',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example');
      assert.match(res.headers.get('access-control-allow-methods') ?? '', /DELETE/);
      assert.match(res.headers.get('access-control-allow-methods') ?? '', /GET/);
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/);
    } finally {
      await app.close();
    }
  });

  test('DELETE is an authenticated route: no grant to an unlisted origin', async () => {
    // The preflight exists for the DELETE, which carries a key, so it takes the
    // authenticated policy — never default-open, unlike the public reads.
    const { catalog } = pointCatalog();
    const app = await serve({ catalog });
    try {
      const res = await app.request('/discovery/resource', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'DELETE',
        },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    } finally {
      await app.close();
    }
  });
});
