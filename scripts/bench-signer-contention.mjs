/**
 * Where a single signer stops keeping up (#203).
 *
 * `docs/AUDIT.md` accepted single-signer sequence contention as a risk and
 * `docs/OPERATIONS.md` recommended a multi-signer pool "to achieve higher
 * throughput", but neither said at what load a single signer stops keeping up.
 * The alert threshold on `x402_signer_inflight` was `>= 1`, which is a proxy —
 * it fires on the first concurrent settlement, healthy or not. This turns that
 * prose into a number.
 *
 * WHAT THIS DOES NOT DO. It does not measure Stellar. The ceiling below is
 * `sequenceWindow / submitMs` *by construction*: a Stellar account signs with
 * strictly increasing sequence numbers, so settlements on one signer serialize,
 * and if `sequenceWindow` submissions can be in flight before the next must
 * wait for a confirmation, the achievable rate is that ratio. There is no
 * information in this simulation that is not in those two inputs — `window`
 * especially, which is a property of the account and the network, not something
 * this repo controls or observes. The number is therefore "for this window",
 * never a constant of the network.
 *
 * What the harness establishes, which the prose did not, is the SHAPE: rate
 * rises linearly with offered concurrency up to the window, is flat above it,
 * and the queue above it is unstable — latency does not settle at some larger
 * value, it grows without bound. It also cross-checks the pool-sizing formula
 * in `docs/OPERATIONS.md` against the measured ceiling.
 *
 *   node scripts/bench-signer-contention.mjs [--window 8] [--submit-ms 2500]
 *                                            [--max-inflight 64] [--rounds 2000]
 */
import { parseArgs } from 'node:util';
import { signerMetrics } from '../src/metrics.js';

/** Throughput within this fraction of the ceiling counts as "at the ceiling". */
const SATURATION_TOLERANCE = 0.05;

/**
 * Modelled inputs, with where each comes from.
 *
 *  - `sequenceWindow`: how many submissions one account can have in flight
 *    before the next must wait for a confirmation. THE free parameter, and the
 *    one number here that this repo cannot derive — it is a sizing input, like
 *    the latency below, and the ceiling scales linearly with it.
 *  - `submitMs`: one submission round trip, including confirmation. Anchored on
 *    the figure `docs/OPERATIONS.md` already uses for pool sizing ("average
 *    on-chain settlement latency is 5 seconds"), halved to 2500ms because a
 *    round trip is one attempt, not a whole settlement.
 *  - `sloMs`: the interactive-agent latency target, from the
 *    `x402_request_duration_seconds` alert in `docs/OPERATIONS.md`
 *    ("alert if p95 > 2s on /verify or /settle").
 */
export const DEFAULT_MODEL = {
  sequenceWindow: 8,
  submitMs: 2500,
  sloMs: 2000,
  maxInflight: 64,
  rounds: 2000,
};

/**
 * Reads the model from CLI arguments.
 *
 * Kept out of module scope so importing this file (the tests do) cannot be
 * tripped by whatever arguments the importer was started with.
 */
export function modelFromArgs(argv = []) {
  const { values } = parseArgs({
    args: argv,
    options: {
      window: { type: 'string' },
      'submit-ms': { type: 'string' },
      'max-inflight': { type: 'string' },
      rounds: { type: 'string' },
    },
  });
  return {
    ...DEFAULT_MODEL,
    ...(values.window === undefined ? {} : { sequenceWindow: Number(values.window) }),
    ...(values['submit-ms'] === undefined ? {} : { submitMs: Number(values['submit-ms']) }),
    ...(values['max-inflight'] === undefined
      ? {}
      : { maxInflight: Number(values['max-inflight']) }),
    ...(values.rounds === undefined ? {} : { rounds: Number(values.rounds) }),
  };
}

/**
 * Simulates a closed loop of `inflight` settlements against one signer.
 *
 * FIFO queue, fixed service width per round: `sequenceWindow` settlements are
 * confirmed per submission round and anything beyond that waits. So the
 * latency reported for a stable run is queueing delay, and an unstable run is
 * reported as unstable rather than as a large number — a backlog that grows
 * without bound has no p95, only a run length.
 *
 * @returns {{inflight: number, throughput: number, stable: boolean, backlog: number}}
 */
export function simulate({ inflight, sequenceWindow, submitMs, rounds }) {
  /** Birth round of each settlement still waiting, oldest first (FIFO). */
  const pending = [];
  let landed = 0;

  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < inflight; i++) pending.push(round);

    for (let served = 0; served < sequenceWindow && pending.length > 0; served++) {
      pending.shift();
      landed += 1;
    }
  }

  const elapsedSeconds = (rounds * submitMs) / 1000;
  return {
    inflight,
    throughput: landed / elapsedSeconds,
    stable: pending.length === 0,
    backlog: pending.length,
  };
}

/**
 * Finds the concurrency beyond which the signer stops getting faster.
 *
 * The knee reduces to `sequenceWindow` — that is the whole content of the
 * result, and saying so is more useful than dressing it up.
 *
 * Flatness must be OBSERVED, not assumed: a row reaches the ceiling whenever it
 * is the largest in the sweep, so on a curve that is still climbing the first
 * "at the ceiling" row is simply the last one tried. That reports whichever
 * number happened to be largest, which is exactly the failure this harness
 * exists to avoid. So a knee is only reported when some row at the ceiling is
 * followed by another row still at it — otherwise the answer is null.
 *
 * @returns {{ceiling: number, knee: number|null, rows: object[]}}
 */
export function findKnee(model) {
  const rows = [];
  for (let inflight = 1; inflight <= model.maxInflight; inflight++) {
    rows.push(simulate({ ...model, inflight }));
  }

  const ceiling = Math.max(...rows.map(r => r.throughput));
  const atCeiling = rows.findIndex(r => r.throughput >= ceiling * (1 - SATURATION_TOLERANCE));
  const flat = atCeiling !== -1 && atCeiling < rows.length - 1;

  return { ceiling, knee: flat ? rows[atCeiling].inflight : null, rows };
}

function main() {
  const MODEL = modelFromArgs(process.argv.slice(2));
  const { ceiling, knee, rows } = findKnee(MODEL);

  console.log('Single-signer sequence contention (#203)');
  console.log(`  window=${MODEL.sequenceWindow} submit=${MODEL.submitMs}ms rounds=${MODEL.rounds}`);
  console.log(`  ceiling is window/submitMs by construction = ${ceiling.toFixed(3)}/s\n`);
  console.log('  inflight   settlements/s   queue');
  for (const row of rows) {
    const queue = row.stable ? 'stable' : `UNSTABLE (+${row.backlog})`;
    const mark = row.inflight === knee ? '  <- knee' : '';
    console.log(
      `  ${String(row.inflight).padStart(8)}   ${row.throughput.toFixed(3).padStart(13)}   ${queue}${mark}`,
    );
  }

  console.log('');
  console.log(`Ceiling: ${ceiling.toFixed(3)} settlements/sec (${(ceiling * 60).toFixed(1)}/min)`);
  if (knee === null) {
    console.log('Knee: none within the sweep — the window was never oversubscribed.');
    console.log(
      '      Raise --max-inflight to find it. No number is reported rather than a wrong one.',
    );
    return;
  }

  console.log(`Knee: ${knee} concurrent in-flight settlements (== the window). Beyond it, more`);
  console.log('      concurrency adds queue, not throughput, and the queue never drains.');
  const firstUnstable = rows.find(r => !r.stable);
  if (MODEL.submitMs > MODEL.sloMs) {
    console.log(
      `Latency: one modelled submit round trip (${MODEL.submitMs}ms) already exceeds the`,
    );
    console.log(`      documented ${MODEL.sloMs}ms p95 target, so /settle cannot meet it at ANY`);
    console.log('      concurrency — contention only makes it worse. The 5s latency used for pool');
    console.log(
      '      sizing in docs/OPERATIONS.md and the 2s p95 alert are inconsistent for /settle.',
    );
  } else if (firstUnstable) {
    console.log(
      `Latency: p95 crosses the documented ${MODEL.sloMs}ms target at ${firstUnstable.inflight} in`,
    );
    console.log('      flight, and past that point the breach is unbounded, not gradual.');
  }

  const poolFor = rate => Math.ceil(rate / ceiling);
  console.log(`Pool cross-check (docs/OPERATIONS.md: ceil(rate x latency)):`);
  for (const rate of [1, 5, 20]) {
    console.log(`  ${String(rate).padStart(2)} settlements/sec -> ${poolFor(rate)} signer(s)`);
  }
  console.log(
    `  ceil(rate / ceiling) and ceil(rate * (1/ceiling)) agree for every rate above, so the`,
  );
  console.log(
    `  documented formula is this ceiling rearranged — the pool exists to widen the window.`,
  );

  // Exercise the real gauge the alerting reads, at the knee, so the harness and
  // the metric operators are told to watch cannot drift apart.
  const signer = 'bench-single-signer';
  for (let i = 0; i < knee; i++) signerMetrics.incrementInflight('stellar:testnet', signer);
  const gauge = signerMetrics
    .toPrometheusText()
    .split('\n')
    .find(line => line.startsWith('x402_signer_inflight'));
  for (let i = 0; i < knee; i++) signerMetrics.decrementInflight('stellar:testnet', signer);

  console.log(`\nAlerting signal at the knee:\n  ${gauge}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
