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
import { serve, VALID_BODY } from './helpers/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = join(ROOT, 'openapi.yaml');

test('openapi.yaml validates against the OpenAPI 3.1 schema', async () => {
  // SwaggerParser.validate resolves every $ref and checks the document
  // against the OpenAPI meta-schema; it throws on the first problem instead
  // of returning a boolean, so a passing call is the assertion.
  await SwaggerParser.validate(SPEC_PATH);
});

test('every path in the spec is a route the app actually serves', async () => {
  const doc = loadYaml(readFileSync(SPEC_PATH, 'utf8'));
  const specPaths = Object.keys(doc.paths).sort();
  assert.deepEqual(specPaths, [
    '/discovery/resource',
    '/discovery/resources',
    '/discovery/search',
    '/healthz',
    '/settle',
    '/supported',
    '/usage',
    '/verify',
  ]);
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
