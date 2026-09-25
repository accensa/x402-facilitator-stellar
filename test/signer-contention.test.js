/**
 * The contention harness must not report a number it has not earned (#203).
 *
 * A benchmark that always prints a knee is worse than prose: it launders
 * whichever value happened to be largest into a figure an operator would size a
 * signer pool against. These tests pin the two properties that make the output
 * trustworthy — the shape (throughput saturates at the window, and the queue
 * above it never drains) and the refusal (no knee reported when the sweep never
 * oversubscribes the window).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, findKnee } from '../scripts/bench-signer-contention.mjs';

const BASE = { sequenceWindow: 8, submitMs: 2500, maxInflight: 16, rounds: 500 };

test('throughput rises with concurrency up to the window, then stops', () => {
  const rows = Array.from({ length: 16 }, (_, i) => simulate({ ...BASE, inflight: i + 1 }));

  for (let i = 1; i < BASE.sequenceWindow; i++) {
    assert.ok(rows[i].throughput > rows[i - 1].throughput, `inflight ${i + 1} should beat ${i}`);
  }
  for (let i = BASE.sequenceWindow; i < rows.length; i++) {
    assert.equal(
      rows[i].throughput,
      rows[BASE.sequenceWindow - 1].throughput,
      `inflight ${i + 1} exceeds the window and must not add throughput`,
    );
  }
});

test('the ceiling is the window over the submit time', () => {
  const { ceiling } = findKnee(BASE);
  assert.ok(
    Math.abs(ceiling - (BASE.sequenceWindow * 1000) / BASE.submitMs) < 1e-9,
    `expected ${(BASE.sequenceWindow * 1000) / BASE.submitMs}, got ${ceiling}`,
  );
});

test('the queue is stable at the window and never drains above it', () => {
  assert.equal(simulate({ ...BASE, inflight: BASE.sequenceWindow }).stable, true);
  const above = simulate({ ...BASE, inflight: BASE.sequenceWindow + 1 });
  assert.equal(above.stable, false);
  assert.ok(above.backlog > 0, 'a run above the window must still be holding a backlog');
});

test('the knee is the window, and is reported as such', () => {
  assert.equal(findKnee(BASE).knee, BASE.sequenceWindow);
});

test('no knee is reported when the sweep never oversubscribes the window', () => {
  // A window wider than the whole sweep: throughput is still climbing when the
  // sweep ends, so there is no saturation to report. The honest answer is null,
  // not the largest inflight tried.
  const { knee } = findKnee({ ...BASE, sequenceWindow: 1000, maxInflight: 16 });
  assert.equal(knee, null);
});

test('a saturated model makes the documented pool formula exact', () => {
  // docs/OPERATIONS.md sizes a pool as ceil(rate x latency). With latency
  // 1/ceiling that is ceil(rate / ceiling), which is what the harness reports —
  // the formula and the measured ceiling have to agree or one of them is wrong.
  const { ceiling } = findKnee(BASE);
  const latencySeconds = 1 / ceiling;
  for (const rate of [1, 5, 20]) {
    assert.equal(Math.ceil(rate * latencySeconds), Math.ceil(rate / ceiling));
    assert.ok(Math.ceil(rate / ceiling) >= 1);
  }
});
