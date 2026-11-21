import test from 'node:test';
import assert from 'node:assert/strict';
import { ndcg, dcg } from '../eval/runner.js';

test('ndcg yields exactly 1.0 for perfect top-K ranking when ideal list has more than K items (#774)', () => {
  // Scenario: Top-K is 3. Catalog has 10 relevant items with scores.
  const idealScores = [3, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  // Search engine successfully returns the top 3 items
  const actualScores = [3, 3, 3];

  const score = ndcg(actualScores, idealScores);
  assert.equal(
    score,
    1.0,
    `Perfect top-3 ranking must yield nDCG = 1.0, even when judgment has 10 items. Got ${score}`,
  );
});

test('ndcg yields exactly 1.0 for perfect top-K ranking across varying judgment sizes', () => {
  // 5 items in judgment, evaluating top 3
  assert.equal(ndcg([5, 4, 3], [1, 2, 3, 4, 5]), 1.0);

  // 20 items in judgment, evaluating top 3
  const largeIdeal = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  assert.equal(ndcg([20, 19, 18], largeIdeal), 1.0);

  // Exact match with exactly 3 items
  assert.equal(ndcg([3, 2, 1], [3, 2, 1]), 1.0);

  // Judgment has fewer items than evaluated K (e.g. 1 item, K = 3)
  assert.equal(ndcg([3, 0, 0], [3]), 1.0);
});

test('ndcg correctly scores suboptimal rankings against truncated ideal list', () => {
  // Ideal top 3 is [3, 2, 1]. Actual is reversed: [1, 2, 3]
  // Even with more items in idealScores, IDCG is bounded by top 3
  const actual = [1, 2, 3];
  const ideal = [3, 2, 1, 1, 1, 1];

  const score = ndcg(actual, ideal);
  assert.ok(score < 1.0, `Suboptimal ranking score (${score}) must be strictly less than 1.0`);
  assert.ok(score > 0.7, `Suboptimal ranking score (${score}) should reflect partial relevance`);

  // Calculate expected:
  // dcg([1, 2, 3]) = 1/log2(2) + 2/log2(3) + 3/log2(4) = 1 + 1.26186 + 1.5 = 3.76186
  // idcg([3, 2, 1]) = 3/log2(2) + 2/log2(3) + 1/log2(4) = 3 + 1.26186 + 0.5 = 4.76186
  const expected =
    (1 + 2 / Math.log2(3) + 3 / Math.log2(4)) / (3 + 2 / Math.log2(3) + 1 / Math.log2(4));
  assert.ok(
    Math.abs(score - expected) < 1e-6,
    `Expected nDCG score ${expected}, received ${score}`,
  );
});

test('ndcg does not mutate the input caller arrays (#774)', () => {
  const originalIdeal = Object.freeze([1, 4, 2, 5, 3]);
  const idealCopy = [1, 4, 2, 5, 3];
  const actualCopy = [5, 4, 3];

  const score = ndcg(actualCopy, idealCopy);
  assert.equal(score, 1.0);
  assert.deepEqual(
    idealCopy,
    originalIdeal,
    'idealScores array was mutated during ndcg calculation',
  );
  assert.deepEqual(actualCopy, [5, 4, 3], 'actualScores array was mutated during ndcg calculation');
});

test('ndcg preserves zero and division-by-zero handling', () => {
  // Both empty
  assert.equal(ndcg([], []), 1);

  // All zeros in ideal (IDCG = 0)
  assert.equal(ndcg([0, 0, 0], [0, 0, 0]), 0);
  assert.equal(ndcg([], [0, 0]), 1);

  // Actual empty with non-empty ideal
  assert.equal(ndcg([], [3, 2, 1]), 0);

  // Ideal empty with non-empty actual
  assert.equal(ndcg([1, 2], []), 0);
});

test('dcg calculates discounted cumulative gain correctly', () => {
  assert.equal(dcg([]), 0);
  assert.equal(dcg([1]), 1);
  assert.equal(dcg([2, 1]), 2 / Math.log2(2) + 1 / Math.log2(3));
});
