/**
 * Single-signer contention model (#203).
 *
 * Answers one operational question: **at what offered concurrency does one
 * Stellar signer stop keeping up, and what does it settle per second when it
 * does?**
 *
 *   node scripts/bench-signer-contention.mjs [--max-inflight 64] [--rounds 2000]
 *        [--submit-ms 2500] [--sequence-window 8] [--slo-ms 2000] [--json]
 *
 * WHY A MODEL AND NOT A LOAD TEST. The quantity that matters is the account's
 * *sequence window*: a single Stellar account has one sequence number, and the
 * network will only accept a bounded number of transactions built on
 * consecutive sequence numbers before the later ones race each other and come
 * back `tx_bad_seq`. Reproducing that faithfully needs either funded testnet
 * accounts driven to the exact failure point (slow, flaky, costs real
 * sequence numbers, and cannot be tuned to sweep a curve) or a stubbed
 * Horizon that would be measuring the stub. Both would produce a number that
 * looks empirical and is not.
 *
 * So this is an explicit, parameterised model with its assumptions written
 * down. It is a planning tool: it tells you the SHAPE of the ceiling and where
 * the knee is for given assumptions, not a measurement of your deployment.
 * Every parameter is a flag precisely so you can replace my assumptions with
 * yours.
 *
 * THE MODEL
 *
 * - One signer, one account, one sequence number.
 * - A settlement occupies a sequence slot for one round trip (`--submit-ms`).
 * - At most `--sequence-window` settlements may be outstanding at once.
 * - Offered concurrency below the window is fully carried: throughput rises
 *   linearly with concurrency.
 * - Above the window, the excess submissions do not settle — they are the ones
 *   that come back `tx_bad_seq` — but they still consume the signer's
 *   submission capacity, because the round trip that discovers the rejection
 *   is the same round trip that could have carried a settlement. Settled
 *   throughput therefore FALLS above the knee rather than plateauing: a
 *   fraction of a fixed budget is spent on rejects.
 *
 * This is the part operators get wrong. "Add concurrency" past the knee does
 * not hold throughput flat — it makes it worse, while the queue of unserved
 * requests grows without bound.
 *
 * RESULT. With the defaults (an 8-deep sequence window and a 2500 ms round
 * trip) the ceiling is 3.2 settlements/sec (192/min) and the knee is at 8
 * in-flight settlements. Note that the default round trip already exceeds the
 * 2000 ms p95 target the service documents in docs/OPERATIONS.md: the model's
 * reference numbers are not internally consistent with that SLO, and the
 * script says so rather than hiding it. `--slo-ms` matches the model to a
 * different target; with `--submit-ms 2000` the ceiling drops to 4.0/s and the
 * two agree.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * Default parameters. `submitMs` is a round trip (submit + ledger close +
 * confirmation); Stellar closes ledgers every ~5s, so a 2500 ms average models
 * landing mid-window rather than waiting a full close.
 */
export const DEFAULT_MODEL = {
  sequenceWindow: 8,
  submitMs: 2500,
  sloMs: 2000,
  maxInflight: 64,
  rounds: 2000,
};

/**
 * A throughput is treated as "at the ceiling" when it is within this fraction
 * of the maximum. Used to find the knee without demanding exact floating-point
 * equality on a curve that is flat by construction.
 */
const SATURATION_TOLERANCE = 0.01;

/**
 * Simulates one offered concurrency level.
 *
 * @param {object} options
 * @param {number} options.inflight offered concurrent settlements
 * @param {number} options.sequenceWindow max simultaneously outstanding
 * @param {number} options.submitMs round trip per settlement, milliseconds
 * @param {number} options.rounds number of offered settlements in the run
 * @returns {{inflight: number, throughput: number, settled: number, stable: boolean, backlog: number}}
 *   `throughput` is settlements/sec; `stable` is false when the queue grows
 *   without bound; `backlog` is settled-shortfall over the run.
 */
export function simulate({ inflight, sequenceWindow, submitMs, rounds }) {
  const carried = Math.min(inflight, sequenceWindow);
  const roundTripSeconds = submitMs / 1000;

  // Below the window every offered settlement settles; above it, only
  // `carried` of `inflight` do, and the rejected share still costs round trips
  // out of the same budget. See the header for why this falls rather than
  // plateaus.
  const settledFraction = carried / inflight;
  const throughput = (carried / roundTripSeconds) * settledFraction;

  const stable = inflight <= sequenceWindow;
  const backlog = stable ? 0 : (inflight - carried) * rounds;

  return {
    inflight,
    throughput,
    settled: Math.round(carried * rounds),
    stable,
    backlog,
  };
}

/**
 * Sweeps offered concurrency from 1 to `maxInflight` and locates the knee.
 *
 * The knee is the lowest concurrency that reaches the ceiling, and it is only
 * reported when the sweep actually OBSERVED the curve turn — that is, when
 * some row after the ceiling row came in below it. If throughput is still
 * rising at `maxInflight`, the sweep never oversubscribed the signer and there
 * is no knee to report; returning the last row instead would present "I
 * stopped measuring" as "this is the limit".
 *
 * @returns {{ceiling: number, knee: number|null, rows: Array<object>}}
 */
export function findKnee(model) {
  const rows = [];
  for (let inflight = 1; inflight <= model.maxInflight; inflight++) {
    rows.push(simulate({ ...model, inflight }));
  }

  const ceiling = Math.max(...rows.map(row => row.throughput));
  const atCeiling = rows.findIndex(row => row.throughput >= ceiling * (1 - SATURATION_TOLERANCE));
  const observedTurningPoint = atCeiling !== -1 && atCeiling < rows.length - 1;

  return { ceiling, knee: observedTurningPoint ? rows[atCeiling].inflight : null, rows };
}

/** Parses CLI flags into a model, falling back to DEFAULT_MODEL per field. */
export function modelFromArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'max-inflight': { type: 'string' },
      rounds: { type: 'string' },
      'submit-ms': { type: 'string' },
      'sequence-window': { type: 'string' },
      'slo-ms': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const model = { ...DEFAULT_MODEL };
  const numeric = {
    'max-inflight': 'maxInflight',
    rounds: 'rounds',
    'submit-ms': 'submitMs',
    'sequence-window': 'sequenceWindow',
    'slo-ms': 'sloMs',
  };
  for (const [flag, key] of Object.entries(numeric)) {
    if (values[flag] === undefined) continue;
    const parsed = Number(values[flag]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${flag} must be a positive number, got ${JSON.stringify(values[flag])}`);
    }
    model[key] = parsed;
  }
  return { model, json: values.json };
}

function renderReport(model, { ceiling, knee, rows }) {
  const perMinute = (ceiling * 60).toFixed(0);
  const lines = [];

  lines.push('Single-signer settlement contention model (#203)');
  lines.push(
    `  sequence window ${model.sequenceWindow}  round trip ${model.submitMs}ms  ` +
      `offered load ${model.rounds} settlements  SLO ${model.sloMs}ms`,
  );
  lines.push('');
  lines.push(`  ceiling:  ${ceiling.toFixed(3)} settlements/sec  (${perMinute}/min)`);
  lines.push(
    knee === null
      ? '  knee:     not observed — throughput was still rising at the highest ' +
          'offered concurrency; raise --max-inflight'
      : `  knee:     ${knee} in-flight settlements`,
  );
  lines.push('');

  if (model.submitMs > model.sloMs) {
    lines.push(
      `  NOTE: the modelled round trip (${model.submitMs}ms) already exceeds the ` +
        `${model.sloMs}ms p95 target, so no concurrency level in this model meets the SLO.`,
    );
    lines.push(
      `        docs/OPERATIONS.md documents a 2000ms p95 against a ~2500ms reference ` +
        'round trip; the two numbers disagree.',
    );
    lines.push('');
  }

  lines.push('  inflight   settled/s   stable');
  const shown = new Set();
  for (const row of rows) {
    // Print the region around the knee rather than all 64 rows.
    const near = knee === null || Math.abs(row.inflight - knee) <= 4 || row.inflight <= 2;
    if (!near || shown.has(row.inflight)) continue;
    shown.add(row.inflight);
    lines.push(
      `  ${String(row.inflight).padStart(8)}   ${row.throughput.toFixed(3).padStart(9)}   ` +
        (row.stable ? 'yes' : `no (+${row.backlog} backlogged)`),
    );
  }

  return lines.join('\n');
}

function main() {
  const { model, json } = modelFromArgs(process.argv.slice(2));
  const result = findKnee(model);

  if (json) {
    console.log(JSON.stringify({ model, ...result }, null, 2));
    return;
  }
  console.log(renderReport(model, result));
}

// Only run when invoked directly, so the test suite can import the model
// without the CLI parsing argv under `node --test`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
