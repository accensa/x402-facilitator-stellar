/**
 * Every endpoint the app rate-limits must declare HTTP 429 (issue #740).
 *
 * `/discovery/search` is protected by the catalog read limiter in
 * `src/app.js`, exactly like its sibling discovery reads, but its OpenAPI
 * response map omitted the 429 that the siblings declared — so generated
 * clients and validators had no way to recognise a rate-limited search.
 *
 * The rate-limited discovery routes are taken from the implementation
 * (`rejectRateLimited(req, reply, '<route>', ...)` in `src/app.js`) rather
 * than restated here, so a route that gains a limiter without gaining a
 * documented 429 fails this test instead of drifting.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = join(ROOT, 'openapi.yaml');
const APP_PATH = join(ROOT, 'src/app.js');
const RATE_LIMITED_REF = '#/components/responses/RateLimited';

/** The parsed spec, loaded once per test file. */
function loadSpec() {
  return loadYaml(readFileSync(SPEC_PATH, 'utf8'));
}

/**
 * Discovery route paths whose handlers call `rejectRateLimited` in the app.
 * The route string is the third argument to `rejectRateLimited`, which the
 * implementation passes as the literal path being served.
 */
function rateLimitedDiscoveryRoutes() {
  const source = readFileSync(APP_PATH, 'utf8');
  const routes = new Set();
  const pattern = /rejectRateLimited\(\s*req,\s*reply,\s*'(\/discovery\/[^']+)'/g;
  for (const match of source.matchAll(pattern)) routes.add(match[1]);
  return routes;
}

/** `METHOD /path` for every operation under a path prefix. */
function operationsUnder(spec, prefix) {
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!path.startsWith(prefix)) continue;
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (operation === null || typeof operation !== 'object') continue;
      operations.push({ method: method.toUpperCase(), path, operation });
    }
  }
  return operations;
}

test('the RateLimited response component exists', () => {
  const spec = loadSpec();
  const response = spec.components?.responses?.RateLimited;

  assert.ok(response, 'openapi.yaml must define components.responses.RateLimited');
  assert.ok(response.headers?.['RateLimit-Limit'], 'RateLimited must document RateLimit-Limit');
  assert.ok(response.headers?.['Retry-After'], 'RateLimited must document Retry-After');
});

test('/discovery/search declares HTTP 429 referencing RateLimited', () => {
  const spec = loadSpec();
  const responses = spec.paths?.['/discovery/search']?.get?.responses ?? {};

  assert.deepEqual(
    responses['429'],
    { $ref: RATE_LIMITED_REF },
    '/discovery/search must document the 429 its rate limiter can return',
  );
});

test('every rate-limited discovery route documents a 429 response', () => {
  const spec = loadSpec();
  const limited = rateLimitedDiscoveryRoutes();
  const operations = operationsUnder(spec, '/discovery/');

  assert.ok(limited.size > 0, 'src/app.js must call rejectRateLimited for discovery routes');
  assert.ok(
    operations.length > 0,
    'openapi.yaml must document the discovery operations those limiters protect',
  );

  // Every discovery operation is limiter-backed today (reads use the catalog
  // read limit, writes the catalog limit), so each must declare the 429.
  const undocumented = operations
    .filter(({ operation }) => operation.responses?.['429'] === undefined)
    .map(({ method, path }) => `${method} ${path}`);

  assert.deepEqual(
    undocumented,
    [],
    'Discovery operations protected by rate limiting but missing a 429 in openapi.yaml — ' +
      'add `429: { $ref: "#/components/responses/RateLimited" }` to their responses',
  );

  const documentedPaths = new Set(operations.map(({ path }) => path));
  const missingFromSpec = [...limited].filter(path => !documentedPaths.has(path));
  assert.deepEqual(
    missingFromSpec,
    [],
    'Route paths rate-limited in src/app.js but absent from openapi.yaml — the spec would ' +
      'otherwise never cover their 429',
  );
});

test('each declared discovery 429 references the shared RateLimited component', () => {
  const spec = loadSpec();

  for (const { method, path, operation } of operationsUnder(spec, '/discovery/')) {
    const response = operation.responses?.['429'];
    assert.deepEqual(
      response,
      { $ref: RATE_LIMITED_REF },
      `${method} ${path} must reference ${RATE_LIMITED_REF}`,
    );
  }
});
