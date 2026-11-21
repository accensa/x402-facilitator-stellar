import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = fileURLToPath(new URL('../eval/runner.js', import.meta.url));
const QUERIES = fileURLToPath(new URL('../eval/judgements/queries.json', import.meta.url));

const MIN_MARGIN = 0.05;
const MAX_MARGIN = 0.25;
const METRICS = [
  { name: 'nDCG', key: 'ndcg' },
  { name: 'MRR', key: 'mrr' },
];

function declaredThresholds() {
  const source = readFileSync(RUNNER, 'utf8');
  const block = source.match(/\bconst\s+THRESHOLDS\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(block, 'eval/runner.js must declare THRESHOLDS as an object literal');

  const thresholds = {};
  for (const { key } of METRICS) {
    const literal = block[1].match(new RegExp(`\\b${key}\\s*:\\s*(\\d*\\.?\\d+)`));
    assert.ok(literal, `THRESHOLDS.${key} must be a numeric literal in eval/runner.js`);
    thresholds[key] = Number(literal[1]);
    assert.ok(
      Number.isFinite(thresholds[key]) && thresholds[key] > 0 && thresholds[key] <= 1,
      `THRESHOLDS.${key} must be a score in (0, 1], got ${thresholds[key]}`,
    );
  }
  return thresholds;
}

function evaluatedFixtures() {
  const result = spawnSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ok(!result.error, `could not start eval/runner.js: ${result.error}`);
  assert.equal(result.signal, null, `eval runner was killed: ${result.signal}`);
  assert.equal(result.status, 0, `eval runner failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function aggregateMetric(stdout, name) {
  const section = stdout.split('--- Aggregate Metrics ---')[1];
  assert.ok(section, 'eval runner did not print aggregate metrics');
  const literal = section.match(new RegExp(`^${name}:\\s+(\\d*\\.?\\d+)\\s*$`, 'm'));
  assert.ok(literal, `eval runner did not report aggregate ${name}`);
  const value = Number(literal[1]);
  assert.ok(Number.isFinite(value), `aggregate ${name} is not finite: ${literal[1]}`);
  return value;
}

test('eval runner measures fixed fixtures against its declared nDCG and MRR thresholds', t => {
  const judgements = JSON.parse(readFileSync(QUERIES, 'utf8'));
  const thresholds = declaredThresholds();
  const stdout = evaluatedFixtures();

  const header = stdout.match(/Running evaluation against (\d+) queries/);
  assert.ok(header, 'eval runner did not report how many queries it evaluated');
  assert.equal(
    Number(header[1]),
    judgements.length,
    'eval runner did not evaluate the committed judgement set',
  );
  for (const { query } of judgements) {
    assert.ok(
      stdout.includes(`Query: "${query}"`),
      `eval runner did not score the fixed query "${query}"`,
    );
  }

  for (const { name, key } of METRICS) {
    const score = aggregateMetric(stdout, name);
    const floor = thresholds[key];
    const margin = score - floor;
    t.diagnostic(
      `${name}: score ${score.toFixed(3)}, floor ${floor}, margin ${margin.toFixed(3)} ` +
        `(accepted ${MIN_MARGIN}..${MAX_MARGIN})`,
    );
    assert.ok(score > floor, `${name} score ${score} must exceed its floor ${floor}`);
    assert.ok(
      margin >= MIN_MARGIN - 1e-9,
      `${name} margin ${margin.toFixed(3)} is too thin: floor ${floor}, score ${score}`,
    );
    assert.ok(
      margin <= MAX_MARGIN + 1e-9,
      `${name} margin ${margin.toFixed(3)} is too large: floor ${floor}, score ${score}`,
    );
  }
});
