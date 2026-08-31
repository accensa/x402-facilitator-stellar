#!/usr/bin/env node
// Fail if docs/CONFORMANCE.md is stale relative to main: its recorded facilitator
// commit SHA is more than N commits behind HEAD and the report has not been
// touched in those intervening commits.
//
// A stale conformance report is worse than none — it presents a claim that no
// longer matches the code as if it had been re-checked. This script is the gate
// that turns "someone forgot to refresh it" into a red CI run.
//
// The recorded SHA lives in docs/CONFORMANCE.md as an HTML comment:
//   <!-- conformance-facilitator-sha: <sha> -->
//   <!-- conformance-staleness-threshold: <N> -->
// Update it to the current main HEAD (and conformance-anchor-date) whenever you
// actually re-validate the report; that resets the counter.
//
// Usage: node scripts/check-conformance-staleness.mjs [--report=docs/CONFORMANCE.md]

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_REPORT = 'docs/CONFORMANCE.md';

function parseArgs(argv) {
  let report = DEFAULT_REPORT;
  for (const a of argv) {
    if (a.startsWith('--report=')) report = a.slice('--report='.length);
  }
  return { report };
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function ancestorExitCode(sha, ref = 'HEAD') {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, ref], {
      stdio: 'ignore',
    });
    return 0;
  } catch {
    return 1;
  }
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function main() {
  const { report } = parseArgs(process.argv.slice(2));

  let text;
  try {
    text = readFileSync(report, 'utf8');
  } catch {
    fail(`Conformance report not found at ${report}. Create docs/CONFORMANCE.md.`);
  }

  const shaMatch = text.match(/<!--\s*conformance-facilitator-sha:\s*([0-9a-f]+)\s*-->/);
  const thresholdMatch = text.match(/<!--\s*conformance-staleness-threshold:\s*(\d+)\s*-->/);

  if (!shaMatch) {
    fail(
      `${report} has no <!-- conformance-facilitator-sha: <sha> --> marker. ` +
        `Add one with the facilitator commit the report was last reconciled against.`,
    );
  }
  const anchorSha = shaMatch[1];
  const threshold = thresholdMatch ? Number(thresholdMatch[1]) : 50;

  console.log(`Report: ${report}`);
  console.log(`Anchor facilitator SHA: ${anchorSha}`);
  console.log(`Staleness threshold: ${threshold} commits`);

  // The anchor must be an ancestor of HEAD, or the report points at history that
  // main no longer contains (force-push / branch reset).
  if (ancestorExitCode(anchorSha) !== 0) {
    fail(
      `Anchor SHA ${anchorSha} is not an ancestor of HEAD. The report points at ` +
        `history main no longer contains — fix the marker or rebase the report.`,
    );
  }

  const ahead = Number(git(['rev-list', '--count', `${anchorSha}..HEAD`]));
  console.log(`Commits on main since the anchor: ${ahead}`);

  if (ahead <= threshold) {
    console.log(`OK — report is ${ahead} commit(s) behind, within the ${threshold} threshold.`);
    process.exit(0);
  }

  // Too far behind. It is only acceptable if the report was deliberately touched
  // in the intervening commits (i.e. someone re-validated it).
  const log = git(['log', '--name-only', '--pretty=format:', `${anchorSha}..HEAD`, '--', report], {
    allowFail: true,
  });
  const reportTouched = log
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .some(f => f === report || f.endsWith('CONFORMANCE.md'));

  if (reportTouched) {
    console.log(
      `OK — report is ${ahead} commits behind (over threshold) but docs/CONFORMANCE.md ` +
        `was modified in those commits, so it was deliberately re-validated.`,
    );
    process.exit(0);
  }

  fail(
    `Conformance report is STALE: ${ahead} commits ahead of anchor ${anchorSha} ` +
      `(threshold ${threshold}) and docs/CONFORMANCE.md was not updated in any of them. ` +
      `Re-run the conformance suite and refresh ${report} (update the ` +
      `conformance-facilitator-sha marker to the current main HEAD).`,
  );
}

main();
