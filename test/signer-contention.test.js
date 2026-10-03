/**
 * @description Single-signer contention model (#203).
 *
 * Pins the model's shape — linear below the sequence window, falling above it,
 * knee exactly at the window — and the two ways the reporting could lie: a
 * knee reported from a sweep that never oversubscribed, and a CLI that cannot
 * tell you which assumptions produced the number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL,
  simulate,
  findKnee,
  modelFromArgs,
} from '../scripts/bench-signer-contention.mjs';

test('Throughput rises linearly while offered concurrency fits the window', () => {
  for (let inflight = 1; inflight <= DEFAULT_MODEL.sequenceWindow; inflight++) {
    const row = simulate({ ...DEFAULT_MODEL, inflight });
    const expected = inflight / (DEFAULT_MODEL.submitMs / 1000);
    assert.ok(
      Math.abs(row.throughput - expected) < 1e-9,
      `at ${inflight} in-flight, expected ${expected}/s, got ${row.throughput}/s`,
    );
    assert.equal(row.stable, true, `${inflight} fits the window, so nothing backs up`);
    assert.equal(row.backlog, 0);
  }
});

test('Throughput falls above the window, because rejects cost the same round trip', () => {
  const atKnee = simulate({ ...DEFAULT_MODEL, inflight: DEFAULT_MODEL.sequenceWindow });
  const above = simulate({ ...DEFAULT_MODEL, inflight: DEFAULT_MODEL.sequenceWindow * 2 });

  assert.ok(
    above.throughput < atKnee.throughput,
    'adding concurrency past the knee must not be reported as holding throughput flat',
  );
  assert.equal(above.stable, false);
  assert.ok(above.backlog > 0, 'an unstable queue must report a growing backlog');
});

test('The knee is exactly the sequence window, and the ceiling is window/round-trip', () => {
  const { ceiling, knee } = findKnee(DEFAULT_MODEL);
  const expectedCeiling = DEFAULT_MODEL.sequenceWindow / (DEFAULT_MODEL.submitMs / 1000);

  assert.equal(knee, DEFAULT_MODEL.sequenceWindow);
  assert.ok(Math.abs(ceiling - expectedCeiling) < 1e-9, `expected ${expectedCeiling}/s`);
  // The number ops needs: settlements per minute before a second signer is
  // required.
  assert.equal(Math.round(ceiling * 60), 192);
});

test('No knee is reported when the sweep never oversubscribed the signer', () => {
  // The bug this guards: `Math.max` on a still-rising curve returns the last
  // row, so a sweep that never reached the window would blame the limit on
  // the sweep's own endpoint. Unobserved must be reported as unobserved.
  const { knee } = findKnee({ ...DEFAULT_MODEL, maxInflight: 4 });
  assert.equal(knee, null);
});

test('A wider sequence window raises the ceiling without moving the shape', () => {
  const wider = { ...DEFAULT_MODEL, sequenceWindow: 16 };
  const narrow = findKnee(DEFAULT_MODEL);
  const wide = findKnee(wider);

  assert.equal(wide.knee, 16);
  assert.equal(wide.ceiling, narrow.ceiling * 2, 'twice the window is twice the ceiling');
});

test('Every model parameter is settable from the command line', () => {
  const { model, json } = modelFromArgs([
    '--max-inflight',
    '32',
    '--rounds',
    '10',
    '--submit-ms',
    '1000',
    '--sequence-window',
    '4',
    '--slo-ms',
    '500',
    '--json',
  ]);

  assert.deepEqual(model, {
    maxInflight: 32,
    rounds: 10,
    submitMs: 1000,
    sequenceWindow: 4,
    sloMs: 500,
  });
  assert.equal(json, true);
});

test('An unparseable model parameter is rejected rather than silently ignored', () => {
  // A typo'd flag that falls back to the default would print a confident
  // number for assumptions the operator did not choose.
  for (const argv of [['--submit-ms', 'fast'], ['--sequence-window', '0'], ['--max-inflight=-1']]) {
    assert.throws(
      () => modelFromArgs(argv),
      /must be a positive number/,
      `argv: ${argv.join(' ')}`,
    );
  }
  // A value beginning with `-` is ambiguous to parseArgs and throws there
  // instead; it must not be treated as "flag absent".
  assert.throws(() => modelFromArgs(['--max-inflight', '-1']));
});
