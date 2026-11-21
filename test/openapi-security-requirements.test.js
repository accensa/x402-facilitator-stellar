/**
 * Issue #741: openapi.yaml declared an `ApiKeyAuth` security scheme but no
 * operation required it. Generated SDKs therefore did not attach API keys to
 * the endpoints the transport protects, and documentation readers could not
 * tell a keyed route from an intentionally public one.
 *
 * This suite keeps the declarations honest in two directions:
 *
 *  - structurally, every operation must declare its own `security` (never
 *    inherit the document default by accident), and it must be one of the two
 *    shapes this service actually has: `security: []` for public routes, or
 *    `security: [{ ApiKeyAuth: [] }]` for keyed routes;
 *  - behaviourally, each declaration is driven against the real auth
 *    middleware from src/app.js. In keyed mode an anonymous request to a
 *    declared-keyed operation must be refused (401), and an anonymous request
 *    to a declared-public operation must not be. In open mode, only the routes
 *    that use the strict check (`/usage`, `/admin/dlq/*`) may still refuse —
 *    the conditional `requireApiKey` routes must accept anonymous callers,
 *    which is why the spec describes open mode in the scheme description
 *    rather than making every keyed operation unresolvable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { serve, testConfig, TEST_SECRET } from './helpers/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = join(ROOT, 'openapi.yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head'];

/**
 * Every operation in the document, with its resolved security requirement.
 * `path` is the OpenAPI form (`/settlements/{idempotencyKey}`); `url` is the
 * same path with the placeholders filled so the real app can route it.
 */
function documentedOperations() {
  const doc = loadYaml(readFileSync(SPEC_PATH, 'utf8'));
  const operations = [];

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      if (operation === null || typeof operation !== 'object') continue;

      operations.push({
        method: method.toUpperCase(),
        path,
        url: path.replace('{idempotencyKey}', 'openapi-security-key').replace('{id}', '1'),
        security: operation.security,
        operationId: operation.operationId ?? '',
      });
    }
  }

  return { doc, operations };
}

/** The stub DeadLetterStore src/app.js's `extras.dlq` seam expects. */
function stubDlq() {
  return {
    store: {
      list: async () => ({ items: [], total: 0 }),
      get: async () => null,
      discard: async () => {},
    },
    publish: async () => {},
    retryOptions: {},
  };
}

/** An anonymous request — deliberately no Authorization header. */
async function anonymousRequest(client, { method, url }) {
  const res = await client.request(url, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    body: method === 'POST' ? '{}' : undefined,
  });
  return res.status;
}

const isPublic = operation => Array.isArray(operation.security) && operation.security.length === 0;
const isKeyed = operation =>
  Array.isArray(operation.security) &&
  operation.security.length === 1 &&
  JSON.stringify(operation.security[0]) === JSON.stringify({ ApiKeyAuth: [] });

/**
 * The routes using `requireApiKeyStrict` in src/app.js:549 and
 * src/dlq/routes.js. They refuse even in open mode, unlike the conditional
 * `requireApiKey` routes. Kept explicit here so a route silently switching
 * checks is a failure rather than a documentation update.
 */
const STRICT_OPERATIONS = new Set([
  'GET /usage',
  'GET /admin/dlq',
  'GET /admin/dlq/{id}',
  'DELETE /admin/dlq/{id}',
  'POST /admin/dlq/{id}/replay',
]);

test('every operation declares an explicit security requirement', () => {
  const { doc, operations } = documentedOperations();

  assert.ok(operations.length > 0, 'openapi.yaml must document at least one operation');

  const inherited = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      if (!operation || typeof operation !== 'object') continue;
      if (!Object.hasOwn(operation, 'security')) inherited.push(`${method.toUpperCase()} ${path}`);
    }
  }

  assert.deepEqual(
    inherited,
    [],
    'Operations with no own `security` key inherit the document-level default; a generated ' +
      'client cannot tell keyed routes from public ones. Declare ApiKeyAuth or security: [] ' +
      'on every operation.',
  );
});

test('each security requirement is one of the two shapes this service serves', () => {
  const { doc, operations } = documentedOperations();
  const schemes = doc.components?.securitySchemes ?? {};

  assert.ok(schemes.ApiKeyAuth, 'components.securitySchemes.ApiKeyAuth must exist');

  for (const operation of operations) {
    const route = `${operation.method} ${operation.path}`;
    assert.ok(Array.isArray(operation.security), `${route}: security must be an array`);

    if (isPublic(operation)) continue;

    assert.ok(
      isKeyed(operation),
      `${route}: expected exactly [{ ApiKeyAuth: [] }] or [], got ` +
        `${JSON.stringify(operation.security)}`,
    );
  }
});

test('keyed operations require a key in keyed mode (anonymous is 401)', async () => {
  const { operations } = documentedOperations();
  const keyed = operations.filter(isKeyed);

  assert.ok(keyed.length > 0, 'there must be at least one keyed operation');

  const client = await serve({
    config: testConfig({ apiKeys: [`test:${TEST_SECRET}`] }),
    extras: { dlq: stubDlq() },
  });

  try {
    for (const operation of keyed) {
      const status = await anonymousRequest(client, operation);
      assert.equal(
        status,
        401,
        `${operation.method} ${operation.path} declares ApiKeyAuth but answered ${status} ` +
          'without an Authorization header',
      );
    }
  } finally {
    await client.close();
  }
});

test('public operations accept an anonymous caller in keyed mode (never 401)', async () => {
  const { operations } = documentedOperations();
  const publicOperations = operations.filter(isPublic);

  assert.ok(publicOperations.length > 0, 'there must be at least one public operation');

  const client = await serve({
    config: testConfig({ apiKeys: [`test:${TEST_SECRET}`] }),
    extras: { dlq: stubDlq() },
  });

  try {
    for (const operation of publicOperations) {
      const status = await anonymousRequest(client, operation);
      assert.notEqual(
        status,
        401,
        `${operation.method} ${operation.path} declares security: [] but refused an ` +
          'anonymous request with 401',
      );
    }
  } finally {
    await client.close();
  }
});

test('open mode accepts anonymous callers except on the strict routes', async () => {
  // With no keys configured, requireApiKey is a no-op while requireApiKeyStrict
  // still refuses — the exact split src/auth-http.js implements. This is the
  // distinction the scheme description documents, and it must not drift.
  const { operations } = documentedOperations();
  const client = await serve({ config: testConfig({}), extras: { dlq: stubDlq() } });

  try {
    for (const operation of operations) {
      const route = `${operation.method} ${operation.path}`;
      const status = await anonymousRequest(client, operation);

      if (STRICT_OPERATIONS.has(route)) {
        assert.equal(status, 401, `${route} uses requireApiKeyStrict and must refuse open mode`);
      } else {
        assert.notEqual(
          status,
          401,
          `${route} uses the conditional key check and must accept anonymous callers in ` +
            'open mode',
        );
      }
    }
  } finally {
    await client.close();
  }
});

test('the strict routes are the ones documented as ApiKeyAuth', () => {
  // Guards the set above against the spec drifting the other way: every strict
  // route must also be declared keyed, so an SDK never treats /usage or the DLQ
  // operator surface as public.
  const { operations } = documentedOperations();
  const byRoute = new Map(
    operations.map(operation => [`${operation.method} ${operation.path}`, operation]),
  );

  for (const route of STRICT_OPERATIONS) {
    const operation = byRoute.get(route);
    assert.ok(operation, `${route} is not documented in openapi.yaml`);
    assert.ok(isKeyed(operation), `${route} must declare ApiKeyAuth in openapi.yaml`);
  }
});
