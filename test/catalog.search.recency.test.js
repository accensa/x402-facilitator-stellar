/**
 * #681: pins the exact recency-decay curve `scoreResource` applies.
 *
 * The curve is a product decision, not an implementation detail: it decides how
 * far a stale listing may fall behind a fresh one, and every ranking result and
 * every `eval/` score moves when the divisor moves. test/catalog.search.test.js
 * only asserts the direction and a loose 0.4–0.6 band at 30 days, which admits
 * any e-folding constant from about 33 to 59 days — so changing 43 to 55 keeps
 * that suite green while changing the product. These tests freeze the clock and
 * pin the factors themselves, so such a change fails loudly and has to be
 * argued for in the diff.
 *
 * The divisor is not a round number on its own: it is the e-folding time whose
 * half-life is ~30 days. `exp(-30 / 43) ≈ 0.4978`, so a listing a month old
 * keeps roughly half its undecayed weight, while `exp(-43 / 43) = exp(-1)`
 * pins the constant itself rather than inferring it from the half-life claim.
 *
 * `t.mock` is scoped to the test that installs it, so the frozen clock is
 * restored when that test ends and no other file — or test in this file — ever
 * sees it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreResource } from '../src/catalog/search.js';

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The fixed instant every test in this file scores against (2026-11-20Z). */
const NOW = Date.parse('2026-11-20T00:00:00.000Z');

/**
 * The undecayed weight of the fixture below: `serviceName` matches the query at
 * weight 10, and nothing else (tags, description, extensions, payment source)
 * contributes.
 */
const FRESH_SCORE = 10;

/**
 * Builds the fixture, aged by `days` from the frozen instant. A `Date` is used
 * because that is the shape the in-memory store persists; the string and number
 * shapes are covered by test/catalog.search.test.js.
 *
 * @param {number} days - age in days; a negative value is in the future
 * @returns {{ serviceName: string, last_seen_at: Date }}
 */
function agedByDays(days) {
  return { serviceName: 'Weather', last_seen_at: new Date(NOW - days * DAY_MS) };
}

/**
 * Freezes `Date` at {@link NOW} for the duration of one test.
 *
 * @param {import('node:test').TestContext} t
 */
function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
}

describe('scoreResource — recency decay curve (#681)', () => {
  test('~30-day half-life: a 30-day-old listing keeps exp(-30/43) of its score', t => {
    freezeClock(t);
    const factor = scoreResource(agedByDays(30), 'weather') / FRESH_SCORE;
    const expected = Math.exp(-30 / 43);
    assert.ok(
      Math.abs(factor - expected) < 1e-9,
      `expected the ~30-day half-life factor ${expected}, got ${factor}`,
    );
    // The claim the constant exists for: one month costs roughly half the score.
    assert.ok(factor > 0.49 && factor < 0.51, `expected ~0.5 of the fresh score, got ${factor}`);
  });

  test('the e-folding constant is 43 days: a 43-day-old listing keeps exp(-1)', t => {
    freezeClock(t);
    const factor = scoreResource(agedByDays(43), 'weather') / FRESH_SCORE;
    assert.ok(
      Math.abs(factor - Math.exp(-1)) < 1e-9,
      `expected exp(-1) = ${Math.exp(-1)}, got ${factor}`,
    );
  });

  test('a zero-age listing scores the undecayed weight', t => {
    freezeClock(t);
    assert.strictEqual(scoreResource(agedByDays(0), 'weather'), FRESH_SCORE);
  });

  test('a future last_seen_at is not amplified', t => {
    freezeClock(t);
    assert.strictEqual(scoreResource(agedByDays(-5), 'weather'), FRESH_SCORE);
  });

  test('an unparseable last_seen_at skips decay without throwing', t => {
    freezeClock(t);
    for (const value of ['not-a-date', {}, [], new Date('nope'), Number.NaN]) {
      assert.strictEqual(
        scoreResource({ serviceName: 'Weather', last_seen_at: value }, 'weather'),
        FRESH_SCORE,
        `expected the undecayed score for ${String(value)}`,
      );
    }
  });

  test('a listing old enough to underflow still yields a finite score', t => {
    freezeClock(t);
    const score = scoreResource(agedByDays(365 * 100), 'weather');
    assert.ok(Number.isFinite(score), 'decay must never produce NaN or Infinity');
    assert.ok(score < FRESH_SCORE, 'a very old listing scores well below a fresh one');
  });
});
