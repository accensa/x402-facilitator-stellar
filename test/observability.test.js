/**
 * Observability: structured request logs, request correlation, redaction, and
 * the Prometheus /metrics endpoint.
 *
 * The house rule: verify/settle live upstream, so this only tests the service
 * around it — the logging and metrics surface — with stubbed collaborators.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, stubFacilitator, VALID_BODY } from './helpers/app.js';
import { createRequestLog } from '../src/log.js';
import { createMetrics } from '../src/metrics.js';

// A sentinel we will plant in the request body. If it ever reaches the log sink,
// the redaction contract is broken. It is shaped like real content would be.
const SENTINEL = 'SENTINEL_DO_NOT_LOG_9f2c7a1b';

function capturingLogger() {
  const lines = [];
  const logger = createRequestLog({ level: 'debug', sink: msg => lines.push(msg) });
  return { logger, lines };
}

test('every request emits exactly one structured JSON line with the required fields', async () => {
  const lines = [];
  const logger = createRequestLog({ level: 'debug', sink: msg => lines.push(msg) });
  const app = await serve({
    extras: {
      logger,
      metrics: createMetrics(),
      signers: { 'stellar:testnet': 'GABCDEF' },
      serveMetrics: true,
    },
  });
  try {
    const res = await app.post('/verify', VALID_BODY);
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }

  assert.equal(lines.length, 1, 'expected exactly one log line per request');
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), [
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
    'ts',
    'txHash',
  ]);
  assert.equal(parsed.route, '/verify');
  assert.equal(parsed.network, 'stellar:testnet');
  assert.equal(parsed.scheme, 'exact');
  assert.equal(parsed.outcome, 'ok');
  assert.equal(parsed.reason, 'none');
});

test('X-Request-Id is accepted, generated when absent, and echoed', async () => {
  const { logger } = capturingLogger();
  const app = await serve({
    extras: {
      logger,
      metrics: createMetrics(),
      signers: { 'stellar:testnet': 'GABCDEF' },
      serveMetrics: true,
    },
  });
  try {
    // Absent: server mints one and echoes it.
    const a = await app.post('/verify', VALID_BODY);
    assert.equal(a.status, 200);
    const minted = a.headers.get('X-Request-Id');
    assert.match(minted, /^[0-9a-f-]{36}$/);

    // Supplied: server honours and echoes it.
    const b = await app.post('/verify', VALID_BODY, { 'X-Request-Id': 'caller-42' });
    assert.equal(b.headers.get('X-Request-Id'), 'caller-42');
  } finally {
    await app.close();
  }
});

test('redaction: a sentinel in the body never reaches the log sink', async () => {
  const lines = [];
  const logger = createRequestLog({ level: 'debug', sink: msg => lines.push(msg) });
  const body = {
    ...VALID_BODY,
    paymentPayload: {
      ...VALID_BODY.paymentPayload,
      payload: { transaction: SENTINEL },
    },
  };
  const app = await serve({
    extras: {
      logger,
      metrics: createMetrics(),
      signers: { 'stellar:testnet': 'GABCDEF' },
      serveMetrics: true,
    },
  });
  try {
    // Exercise both payment routes; the sentinel lives in the transaction.
    const v = await app.post('/verify', body);
    assert.equal(v.status, 200);
    const s = await app.post('/settle', body);
    assert.equal(s.status, 200);
  } finally {
    await app.close();
  }

  assert.ok(lines.length >= 2, 'expected structured lines for both requests');
  for (const line of lines) {
    assert.equal(line.includes(SENTINEL), false, `sentinel leaked into a log line: ${line}`);
    // Each line must be valid JSON with the whitelisted shape.
    const parsed = JSON.parse(line);
    assert.equal(parsed.event, 'request');
    assert.equal('transaction' in parsed, false, 'raw transaction must never be logged');
    assert.equal('payload' in parsed, false);
  }
});

test('GET /metrics serves valid Prometheus text with the required series', async () => {
  const app = await serve({
    extras: {
      logger: createRequestLog({ sink: () => {} }),
      metrics: createMetrics(),
      signers: { 'stellar:testnet': 'GABCDEF' },
      serveMetrics: true,
    },
  });
  try {
    const res = await app.get('/metrics');
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get('content-type'),
      /text\/plain/,
      'metrics content type must be text/plain',
    );
    const text = await res.text();

    for (const name of [
      'x402_requests_total',
      'x402_request_duration_seconds',
      'x402_settlements_total',
      'x402_settlement_fee_stroops',
      'x402_rpc_retries_total',
      'x402_signer_inflight',
    ]) {
      assert.ok(text.includes(`# TYPE ${name} `), `missing series ${name}`);
    }
  } finally {
    await app.close();
  }
});

test('metrics reflect observed requests, settlements, fees and signer state', async () => {
  const metrics = createMetrics();
  const app = await serve({
    // A settle that reports a real fee so the fee histogram gets a sample.
    facilitator: stubFacilitator({
      settle: async (payload, requirements) => ({
        success: true,
        transaction: 'txhash',
        network: requirements.network,
        transactionFeeStroops: 12000,
      }),
    }),
    extras: {
      logger: createRequestLog({ sink: () => {} }),
      metrics,
      signers: { 'stellar:testnet': 'GABCDEF' },
      serveMetrics: true,
    },
  });
  try {
    assert.equal((await app.post('/verify', VALID_BODY)).status, 200);
    assert.equal((await app.post('/settle', VALID_BODY)).status, 200);
  } finally {
    await app.close();
  }

  const text = metrics.render();

  assert.ok(
    text.includes(
      'x402_requests_total{route="/verify",network="stellar:testnet",outcome="ok",reason="none"} 1',
    ),
    'verify request not counted correctly',
  );
  assert.ok(
    text.includes(
      'x402_requests_total{route="/settle",network="stellar:testnet",outcome="ok",reason="none"} 1',
    ),
    'settle request not counted correctly',
  );
  assert.ok(
    text.includes('x402_settlements_total{network="stellar:testnet",outcome="settled"} 1'),
    'settlement not counted',
  );
  assert.ok(
    text.includes('x402_signer_inflight{network="stellar:testnet",signer="GABCDEF"} 0'),
    'signer inflight gauge missing/zero',
  );
  // Fee histogram must have recorded the 12000-stroop sample.
  assert.ok(
    text.includes('x402_settlement_fee_stroops_sum{network="stellar:testnet"} 12000'),
    'settlement fee not recorded',
  );
  // Duration histogram must have a count for /verify.
  assert.ok(
    text.includes(
      'x402_request_duration_seconds_count{route="/verify",network="stellar:testnet"} 1',
    ),
    'request duration histogram not recorded',
  );
});
