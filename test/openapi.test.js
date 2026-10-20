/**
 * Keeps openapi.yaml honest: it must be a valid OpenAPI 3.1 document, and at
 * least one live response from the real app must match what it describes. A
 * spec that drifts silently is worse than no spec — see #71.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import { createApp } from '../src/app.js';
import {
  serve,
  stubCatalog,
  stubFacilitator,
  stubRateLimiter,
  testConfig,
  VALID_BODY,
} from './helpers/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = join(ROOT, 'openapi.yaml');

test('openapi.yaml validates against the OpenAPI 3.1 schema', async () => {
  // SwaggerParser.validate resolves every $ref and checks the document
  // against the OpenAPI meta-schema; it throws on the first problem instead
  // of returning a boolean, so a passing call is the assertion.
  await SwaggerParser.validate(SPEC_PATH);
});

/**
 * `METHOD /path` for every route the app registers — the technique
 * test/docs-routes.test.js already uses: parse the tree from
 * app.printRoutes({ commonPrefix: false }). Fastify spells params `:id`
 * where OpenAPI spells them `{id}`, so normalize to the spec form here.
 * The DLQ store is stubbed (registration is what matters — no request runs)
 * so the `/admin/dlq` routes from src/dlq/routes.js are covered too.
 */
async function registeredOperations() {
  const app = await createApp(
    testConfig({}),
    stubFacilitator(),
    stubRateLimiter(),
    stubCatalog(),
    undefined,
    { dlq: { store: {}, publish: async () => {}, retryOptions: {} } },
  );

  try {
    const tree = app.printRoutes({ commonPrefix: false });
    const routes = new Set();

    const stack = [];
    for (const raw of tree.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line) continue;

      let depth = 0;
      let i = 0;
      while (i + 4 <= line.length) {
        const level = line.slice(i, i + 4);
        if (level === '    ' || level === '│   ') {
          depth += 1;
          i += 4;
        } else {
          break;
        }
      }

      const match = line.slice(i).match(/^[├└]──\s(.+)$/);
      if (!match) continue;

      const label = match[1];
      const paren = label.lastIndexOf(' (');
      const path = paren === -1 ? label : label.slice(0, paren);
      const methods = paren === -1 ? [] : label.slice(paren + 2, -1).split(', ');

      stack.length = depth;
      stack[depth] = path;
      const fullPath = stack.join('').replace(/:([^/]+)/g, '{$1}');

      for (const method of methods) {
        // Fastify auto-registers HEAD for every GET, and OPTIONS preflights
        // are CORS plumbing — neither is API surface the spec must enumerate.
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        routes.add(`${method} ${fullPath}`);
      }
    }

    return routes;
  } finally {
    await app.close();
  }
}

/** `METHOD /path` for every operation openapi.yaml documents. */
function documentedOperations() {
  const doc = loadYaml(readFileSync(SPEC_PATH, 'utf8'));
  const routes = new Set();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head'].includes(method)) continue;
      if (operation === null || typeof operation !== 'object') continue;
      routes.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

test('every route the app serves is documented in openapi.yaml', async () => {
  const app = await registeredOperations();
  const doc = documentedOperations();

  const missing = [...app].filter(route => !doc.has(route));
  assert.deepEqual(
    missing,
    [],
    'Routes registered in src/app.js / src/dlq/routes.js but missing from openapi.yaml — ' +
      'document them instead of letting the spec drift',
  );
});

test('every operation in openapi.yaml is a route the app actually serves', async () => {
  const app = await registeredOperations();
  const doc = documentedOperations();

  const phantom = [...doc].filter(route => !app.has(route));
  assert.deepEqual(
    phantom,
    [],
    'Operations documented in openapi.yaml but not registered by the app — ' +
      'either the spec has a typo or the route was removed without updating it',
  );
});

test('a live GET /healthz response matches its documented schema', async () => {
  const doc = await SwaggerParser.dereference(SPEC_PATH);
  const schema = doc.paths['/healthz'].get.responses['200'].content['application/json'].schema;

  const app = await serve();
  try {
    const res = await app.get('/healthz');
    const body = await res.json();

    const ajv = new Ajv({ strict: false });
    const validateBody = ajv.compile(schema);
    assert.ok(validateBody(body), JSON.stringify(validateBody.errors));
  } finally {
    await app.close();
  }
});

test('a live POST /verify success response matches its documented schema', async () => {
  const doc = await SwaggerParser.dereference(SPEC_PATH);
  const schema = doc.paths['/verify'].post.responses['200'].content['application/json'].schema;

  const app = await serve();
  try {
    const res = await app.post('/verify', VALID_BODY);
    const body = await res.json();

    const ajv = new Ajv({ strict: false });
    const validateBody = ajv.compile(schema);
    assert.ok(validateBody(body), JSON.stringify(validateBody.errors));
  } finally {
    await app.close();
  }
});

test('a live POST /settle success response matches its documented schema', async () => {
  const doc = await SwaggerParser.dereference(SPEC_PATH);
  const schema = doc.paths['/settle'].post.responses['200'].content['application/json'].schema;

  const app = await serve();
  try {
    const res = await app.post('/settle', VALID_BODY);
    const body = await res.json();

    const ajv = new Ajv({ strict: false });
    const validateBody = ajv.compile(schema);
    assert.ok(validateBody(body), JSON.stringify(validateBody.errors));
  } finally {
    await app.close();
  }
});
