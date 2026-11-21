/**
 * `/discovery/search` must declare HTTP 429 (issue #740).
 *
 * `/discovery/search` is protected by the catalog read limiter in
 * `src/app.js`, exactly like its sibling discovery reads, but its OpenAPI
 * response map omitted the 429 that the siblings declared — so generated
 * clients and validators had no way to recognise a rate-limited search.
 *
 * The test checks only that route: the issue's authorized fix is the search
 * operation, so unrelated endpoints are deliberately not asserted on.
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
const SEARCH_PATH = '/discovery/search';
const RATE_LIMITED_REF = '#/components/responses/RateLimited';

/** The parsed spec, loaded once per test file. */
function loadSpec() {
  return loadYaml(readFileSync(SPEC_PATH, 'utf8'));
}

/** The `GET /discovery/search` responses object from the spec. */
function searchResponses(spec) {
  return spec.paths?.[SEARCH_PATH]?.get?.responses ?? {};
}

test('the RateLimited response component exists', () => {
  const spec = loadSpec();
  const response = spec.components?.responses?.RateLimited;

  assert.ok(response, 'openapi.yaml must define components.responses.RateLimited');
  assert.ok(response.headers?.['RateLimit-Limit'], 'RateLimited must document RateLimit-Limit');
  assert.ok(response.headers?.['Retry-After'], 'RateLimited must document Retry-After');
});

test('/discovery/search is rate limited in the application', () => {
  const source = readFileSync(APP_PATH, 'utf8');
  const pattern = /rejectRateLimited\(\s*req,\s*reply,\s*'\/discovery\/search'/;

  assert.match(
    source,
    pattern,
    'src/app.js must guard /discovery/search with rejectRateLimited, or the documented 429 is stale',
  );
});

test('/discovery/search declares HTTP 429 referencing RateLimited', () => {
  const responses = searchResponses(loadSpec());

  assert.deepEqual(
    responses['429'],
    { $ref: RATE_LIMITED_REF },
    '/discovery/search must document the 429 its rate limiter can return',
  );
});
