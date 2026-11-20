/**
 * Pins the status-code contract the spec states and the service implements
 * (#749): `POST /verify` and `POST /settle` return **200** for payment
 * outcomes. `isValid: false` / `success: false` are values in a 200 body, not
 * an HTTP error. 4xx/5xx on these routes describe the transport rejecting the
 * request itself (malformed body, unserved network, bad API key, rate limit).
 *
 * The spec is the source generated SDKs and client integrations are written
 * against, so documenting 402/400/500 as a payment rejection is a
 * conformance break even if the server is unchanged. This test fails on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = loadYaml(readFileSync(join(ROOT, 'openapi.yaml'), 'utf8'));

const PAYMENT_ROUTES = [
  { path: '/verify', outcomeField: 'isValid', description: 'verification' },
  { path: '/settle', outcomeField: 'success', description: 'settlement' },
];

/**
 * The only non-2xx statuses a payment route may document: the transport
 * rejecting the request itself. `402` is deliberately absent — "Payment
 * Required" is exactly the modeling error the spec forbids — and so is every
 * 5xx, because an upstream payment failure is still a 200 with `false`.
 */
const TRANSPORT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]);

/** Reasons a transport-level rejection may carry in a 4xx body. */
const TRANSPORT_REASONS = new Set([
  'invalid_request',
  'unsupported_network',
  'missing_auth_header',
  'malformed_auth_header',
  'invalid_api_key',
  'open_mode_usage_forbidden',
]);

function operation(path, method = 'post') {
  const op = doc.paths?.[path]?.[method];
  assert.ok(op, `openapi.yaml must document ${method.toUpperCase()} ${path}`);
  return op;
}

/** Resolves a local `#/...` JSON pointer so components can be inspected. */
function resolveRef(node) {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string') return node;
  let current = doc;
  for (const part of node.$ref.replace(/^#\//, '').split('/')) {
    current = current?.[part];
  }
  assert.ok(current, `openapi.yaml has an unresolvable $ref: ${node.$ref}`);
  return current;
}

function responseSchema(response) {
  const resolved = resolveRef(response);
  const media = resolved?.content?.['application/json'];
  assert.ok(media?.schema, 'response must document an application/json schema');
  return resolveRef(media.schema);
}

/** Every documented example body under a response, with refs resolved. */
function responseExamples(response) {
  const media = resolveRef(response)?.content?.['application/json'];
  if (!media?.examples) return [];
  return Object.values(media.examples).map(example => resolveRef(example)?.value ?? example);
}

test('the payment routes document exactly one 2xx status: 200', () => {
  for (const { path } of PAYMENT_ROUTES) {
    const responses = operation(path).responses;
    const successStatuses = Object.keys(responses).filter(code => /^2\d\d$/.test(code));
    assert.deepEqual(
      successStatuses,
      ['200'],
      `${path} must model payment results exclusively as HTTP 200`,
    );
  }
});

test('/verify 200 models the outcome in the body, not the status code', () => {
  const { path, outcomeField } = PAYMENT_ROUTES[0];
  const ok = operation(path).responses['200'];
  const schema = responseSchema(ok);

  assert.ok(
    schema.required?.includes(outcomeField),
    `/verify 200 schema must require ${outcomeField}`,
  );
  assert.equal(schema.properties?.[outcomeField]?.type, 'boolean');
  assert.deepEqual(schema.properties?.invalidReason?.type, ['string', 'null']);
  assert.match(
    resolveRef(ok).description ?? '',
    new RegExp(outcomeField),
    `/verify 200 description must tell clients to check ${outcomeField}`,
  );
});

test('/settle 200 models the outcome in the body, not the status code', () => {
  const { path, outcomeField } = PAYMENT_ROUTES[1];
  const ok = operation(path).responses['200'];
  const schema = responseSchema(ok);

  for (const field of [outcomeField, 'transaction', 'network']) {
    assert.ok(schema.required?.includes(field), `/settle 200 schema must require ${field}`);
  }
  assert.equal(schema.properties?.[outcomeField]?.type, 'boolean');
  assert.deepEqual(schema.properties?.errorReason?.type, ['string', 'null']);
  assert.match(
    resolveRef(ok).description ?? '',
    new RegExp(outcomeField),
    `/settle 200 description must tell clients to check ${outcomeField}`,
  );
});

test('the payment routes document no 402 and no 5xx', () => {
  for (const { path } of PAYMENT_ROUTES) {
    const codes = Object.keys(operation(path).responses).filter(code => code !== 'default');
    assert.equal(codes.includes('402'), false, `${path} must not model 402 Payment Required`);
    assert.deepEqual(
      codes.filter(code => Number(code) >= 500),
      [],
      `${path} must not model payment failure as a 5xx`,
    );
  }
});

test('every documented 4xx on a payment route is a transport-level rejection', () => {
  for (const { path } of PAYMENT_ROUTES) {
    const responses = operation(path).responses;
    for (const [code, response] of Object.entries(responses)) {
      if (code === 'default') continue;
      const status = Number(code);
      if (status >= 200 && status < 300) continue;

      assert.ok(
        TRANSPORT_STATUSES.has(status),
        `${path} documents ${code}, which is not a transport-level rejection of the request`,
      );

      for (const example of responseExamples(response)) {
        for (const field of ['invalidReason', 'errorReason']) {
          if (!(field in example) || example[field] === null) continue;
          assert.ok(
            TRANSPORT_REASONS.has(example[field]),
            `${path} ${code} example models a payment rejection reason (${field}: ${example[field]})`,
          );
        }
      }
    }
  }
});

test('the 401 schema enumerates transport-level auth reasons only', () => {
  const authError = resolveRef(doc.components?.schemas?.AuthError);
  const reasons = authError?.properties?.reason?.enum ?? [];
  assert.ok(reasons.length > 0, 'AuthError must enumerate its reasons');
  for (const reason of reasons) {
    assert.ok(
      TRANSPORT_REASONS.has(reason),
      `AuthError reason ${reason} is not a transport-level rejection`,
    );
  }
});

test('the spec states the 200-on-failure rule for both payment routes', () => {
  for (const { path } of PAYMENT_ROUTES) {
    const description = operation(path).description ?? '';
    assert.match(
      description,
      /200/,
      `${path} description must state that a failed payment is still HTTP 200`,
    );
  }
});
