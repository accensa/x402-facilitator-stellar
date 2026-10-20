/**
 * Structured request logging (src/log.js).
 *
 * The contract: exactly the whitelisted fields are emitted, the auth entry /
 * raw transaction / keys / secret never appear, and the level filter honours
 * LOG_LEVEL. Redaction is tested both at the unit level (the whitelist carries
 * no secret-shaped field) and at the request level in test/observability.test.js,
 * which feeds a sentinel through a real request and asserts it never reaches the
 * sink.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLog, parseLogLevel } from '../src/log.js';
import { redact } from '../src/logger.js';

test('parseLogLevel falls back to info on garbage', () => {
  assert.equal(parseLogLevel(undefined), 'info');
  assert.equal(parseLogLevel(''), 'info');
  assert.equal(parseLogLevel('nonsense'), 'info');
  assert.equal(parseLogLevel('WARN'), 'warn');
  assert.equal(parseLogLevel('  error  '), 'error');
});

test('redact masks authorization, cookies and *_secret at any depth', () => {
  const out = redact({
    authorization: 'Bearer s3cret-key',
    'x-request-id': 'abc',
    nested: { api_secret: 'Sabc', keep: 'me' },
  });
  assert.equal(out.authorization, '***');
  assert.equal(out['x-request-id'], 'abc');
  assert.equal(out.nested.api_secret, '***');
  assert.equal(out.nested.keep, 'me');
});

test('begin honours an inbound X-Request-Id, else mints a UUID', () => {
  const logger = createRequestLog({ sink: () => {} });
  const withId = logger.begin({ headers: { 'x-request-id': 'client-123' } });
  assert.equal(withId.requestId, 'client-123');

  const minted = logger.begin({ headers: {} });
  assert.match(minted.requestId, /^[0-9a-f-]{36}$/);
});

test('finish emits exactly one line with the whitelisted fields and nothing else', () => {
  const lines = [];
  const logger = createRequestLog({ sink: msg => lines.push(msg) });
  const span = logger.begin({
    headers: { 'x-request-id': 'r1' },
    routeOptions: { url: '/verify' },
  });
  span.network = 'stellar:testnet';
  span.scheme = 'exact';
  span.keyId = 'key_0';
  logger.finish(span, { outcome: 'ok', reason: 'none' });

  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(logged).sort(), [
    'durationMs',
    'event',
    'keyId',
    'level',
    'network',
    'outcome',
    'reason',
    'requestId',
    'route',
    'scheme',
    'span_id',
    'trace_id',
    'ts',
    'txHash',
  ]);
  assert.equal(logged.event, 'request');
  assert.equal(logged.requestId, 'r1');
  assert.equal(logged.route, '/verify');
  assert.equal(logged.network, 'stellar:testnet');
  assert.equal(logged.outcome, 'ok');
  assert.equal(logged.reason, 'none');
  // txHash is null when no settlement occurred.
  assert.equal(logged.txHash, null);
});

test('finish derives level from outcome (error -> error level)', () => {
  const lines = [];
  const logger = createRequestLog({ sink: msg => lines.push(msg) });
  const span = logger.begin({ headers: {}, routeOptions: { url: '/verify' } });
  logger.finish(span, { outcome: 'error', reason: 'facilitator_error' });
  assert.equal(JSON.parse(lines[0]).level, 'error');
});

test('level filter drops lines below LOG_LEVEL', () => {
  const lines = [];
  // info lines are dropped when level is warn.
  const logger = createRequestLog({ level: 'warn', sink: msg => lines.push(msg) });
  const span = logger.begin({ headers: {}, routeOptions: { url: '/healthz' } });
  logger.finish(span, { outcome: 'ok', reason: 'none' });
  assert.equal(lines.length, 0);

  const span2 = logger.begin({ headers: {}, routeOptions: { url: '/verify' } });
  logger.finish(span2, { outcome: 'error', reason: 'facilitator_error' });
  assert.equal(lines.length, 1);
});

test('W3C traceparent populates trace_id and span_id', () => {
  const logger = createRequestLog({ sink: () => {} });
  const span = logger.begin({
    headers: {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    },
  });
  assert.equal(span.trace_id, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(span.span_id, '00f067aa0ba902b7');
});

test('missing trace context is null, not fabricated', () => {
  const lines = [];
  const logger = createRequestLog({ sink: msg => lines.push(msg) });
  const span = logger.begin({ headers: {}, routeOptions: { url: '/verify' } });
  logger.finish(span, { outcome: 'ok', reason: 'none' });
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.trace_id, null);
  assert.equal(logged.span_id, null);
});

test('value scanning redacts Stellar seeds, bearer tokens, passwords and card numbers', () => {
  const seed = `S${'A'.repeat(55)}`;
  const card = '4111 1111 1111 1111'; // valid Luhn
  const redacted = redact({
    note: `paid with ${card}`,
    transaction: seed,
    detail: 'Authorization: Bearer abc.def.ghi',
    message: 'password=hunter2',
    amount: '1234567890123', // not a valid PAN, must survive
  });

  assert.equal(redacted.transaction, '[REDACTED]');
  assert.equal(redacted.detail.includes('abc.def.ghi'), false);
  assert.equal(redacted.detail.includes('[REDACTED]'), true);
  assert.equal(redacted.message.includes('hunter2'), false);
  assert.equal(redacted.message.includes('[REDACTED]'), true);
  assert.equal(redacted.note.includes('4111'), false);
  assert.equal(redacted.amount, '1234567890123');
});

test('a secret-shaped value in a logged field is redacted at the sink', () => {
  const lines = [];
  const logger = createRequestLog({ sink: msg => lines.push(msg) });
  const span = logger.begin({ headers: {}, routeOptions: { url: '/verify' } });
  span.txHash = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  logger.finish(span, { outcome: 'ok', reason: 'none' });
  assert.equal(JSON.parse(lines[0]).txHash, '[REDACTED]');
});
