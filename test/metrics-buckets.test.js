/**
 * Pins the two Prometheus histograms' bucket layout (#747).
 *
 * `DURATION_BUCKETS` and `FEE_BUCKETS` in `src/metrics.js` are supplied to the
 * `x402_request_duration_seconds` and `x402_settlement_fee_stroops` histograms
 * and are module-private, so this test reads the definitions textually and
 * then checks the rendered exposition. That covers both failure modes the
 * issue names: a bucket array accidentally reordered/duplicated (percentiles
 * and dashboards drift silently) and an exposition that drops a boundary,
 * `+Inf`, `_sum` or `_count`.
 *
 * The assertions are on the rendered `le="..."` edges as well as the source
 * literal, so a histogram that renders buckets in a different order than its
 * definition fails here too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMetrics } from '../src/metrics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const METRICS_PATH = join(ROOT, 'src', 'metrics.js');
const METRICS_SOURCE = readFileSync(METRICS_PATH, 'utf8');

/**
 * Extracts a numeric array literal (`const NAME = [ ... ]`) from the metrics
 * source. Comments inside the literal are stripped before splitting so a
 * commented-out bucket cannot be mistaken for a real one.
 */
function readBucketDefinition(name) {
  const pattern = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`);
  const match = METRICS_SOURCE.match(pattern);
  assert.ok(match, `${name} is not defined as an array literal in src/metrics.js`);

  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const values = body
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      // Underscore separators are valid in a numeric literal (`5_000_000`).
      const value = Number(part.replace(/_/g, ''));
      assert.ok(Number.isFinite(value), `${name} contains a non-numeric bucket: ${part}`);
      return value;
    });

  assert.ok(values.length > 0, `${name} must define at least one bucket`);
  return values;
}

/** `[{ le, count }]` for every `<name>_bucket{...le="..."}` line in `text`. */
function renderedBuckets(text, name) {
  const buckets = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}_bucket{`)) continue;
    const match = line.match(/le="([^"]+)"\}\s+(\d+)$/);
    assert.ok(match, `malformed ${name} bucket line: ${line}`);
    buckets.push({ le: match[1], count: Number(match[2]) });
  }
  return buckets;
}

/**
 * Asserts a rendered histogram is a standard Prometheus exposition for the
 * given definition and observations: every boundary present in definition
 * order, cumulative counts, a terminating `+Inf`, and `_sum`/`_count` labels
 * matching the series.
 */
function assertHistogramExposition(text, { name, labels, buckets, observations }) {
  const rendered = renderedBuckets(text, name);
  const finite = rendered.filter(bucket => bucket.le !== '+Inf');

  assert.deepEqual(
    finite.map(bucket => Number(bucket.le)),
    buckets,
    `${name} did not render every bucket boundary, in definition order`,
  );

  assert.equal(rendered.at(-1)?.le, '+Inf', `${name} must render a terminating +Inf bucket`);
  assert.equal(rendered.at(-1)?.count, observations.length, `${name} +Inf count must be the total`);

  let previous = -1;
  for (const bucket of finite) {
    const expected = observations.filter(observation => observation <= Number(bucket.le)).length;
    assert.equal(
      bucket.count,
      expected,
      `${name} bucket le="${bucket.le}" is not cumulative/correct`,
    );
    assert.ok(bucket.count >= previous, `${name} bucket counts must never decrease`);
    previous = bucket.count;

    assert.ok(
      text.includes(`${name}_bucket{${labels},le="${bucket.le}"} ${bucket.count}`),
      `${name} bucket le="${bucket.le}" is not labelled as expected`,
    );
  }

  const expectedSum = observations.reduce((total, observation) => total + observation, 0);
  const sumLine = text.split('\n').find(line => line.startsWith(`${name}_sum{${labels}} `));
  assert.ok(sumLine, `${name}_sum{${labels}} is missing`);
  assert.ok(
    Math.abs(Number(sumLine.slice(sumLine.lastIndexOf(' ') + 1)) - expectedSum) < 1e-9,
    `${name}_sum does not equal the sum of observations`,
  );

  assert.ok(
    text.includes(`${name}_count{${labels}} ${observations.length}`),
    `${name}_count is missing or not the number of observations`,
  );
}

const HISTOGRAMS = ['DURATION_BUCKETS', 'FEE_BUCKETS'];

test('DURATION_BUCKETS and FEE_BUCKETS are strictly ascending with no duplicates', () => {
  for (const name of HISTOGRAMS) {
    const buckets = readBucketDefinition(name);
    for (let i = 1; i < buckets.length; i++) {
      assert.ok(
        buckets[i] > buckets[i - 1],
        `${name} must be strictly ascending: ${buckets[i - 1]} -> ${buckets[i]} at index ${i}`,
      );
    }
    assert.equal(new Set(buckets).size, buckets.length, `${name} must not contain duplicates`);
    for (const bucket of buckets) {
      assert.ok(bucket > 0, `${name} buckets must be positive, found ${bucket}`);
    }
  }
});

test('the duration histogram renders every duration bucket, +Inf, _sum and _count', () => {
  const buckets = readBucketDefinition('DURATION_BUCKETS');
  const observations = [0.001, 0.3, 7];

  const metrics = createMetrics();
  for (const durationSeconds of observations) {
    metrics.observeRequestDuration({
      route: '/verify',
      network: 'stellar:testnet',
      durationSeconds,
    });
  }

  assertHistogramExposition(metrics.render(), {
    name: 'x402_request_duration_seconds',
    labels: 'route="/verify",network="stellar:testnet"',
    buckets,
    observations,
  });
});

test('the settlement-fee histogram renders every fee bucket, +Inf, _sum and _count', () => {
  const buckets = readBucketDefinition('FEE_BUCKETS');
  // Includes a fee above the last boundary, so the +Inf bucket must absorb it.
  const observations = [1000, 12000, 250000, 9_000_000];

  const metrics = createMetrics();
  for (const feeStroops of observations) {
    metrics.observeSettlementFee({ network: 'stellar:testnet', feeStroops });
  }

  assertHistogramExposition(metrics.render(), {
    name: 'x402_settlement_fee_stroops',
    labels: 'network="stellar:testnet"',
    buckets,
    observations,
  });
});

test('rendered bucket edges are unique per series', () => {
  const metrics = createMetrics();
  metrics.observeRequestDuration({
    route: '/settle',
    network: 'stellar:testnet',
    durationSeconds: 1,
  });
  metrics.observeSettlementFee({ network: 'stellar:testnet', feeStroops: 50000 });

  const text = metrics.render();
  for (const [name, definition] of [
    ['x402_request_duration_seconds', 'DURATION_BUCKETS'],
    ['x402_settlement_fee_stroops', 'FEE_BUCKETS'],
  ]) {
    const edges = renderedBuckets(text, name).map(bucket => bucket.le);
    assert.equal(
      new Set(edges).size,
      edges.length,
      `${name} rendered a duplicate bucket edge: ${edges.join(', ')}`,
    );
    assert.equal(
      edges.length,
      readBucketDefinition(definition).length + 1,
      `${name} must render one line per boundary plus +Inf`,
    );
  }
});
