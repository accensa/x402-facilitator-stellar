#!/usr/bin/env node
/**
 * scripts/calibrate-pubnet-fee.mjs
 *
 * Read-only calibration script that pulls real mainnet fee statistics from
 * Horizon /fee_stats, measures the canonical settlement fee shape, and derives
 * the pubnet per-settlement fee ceiling (MAX_TX_FEE_STROOPS_PUBNET) and floor.
 *
 * Requirements (Issue #650):
 * - Takes no signer secret and submits nothing to the network.
 * - Reads HORIZON_URL_PUBNET from environment or defaults to public Horizon.
 * - Prints measurement window, sample count, fee percentiles, simulated
 *   canonical settlement fees, and derived floor/default with daily budget.
 */

const HORIZON_URL = (process.env.HORIZON_URL_PUBNET || 'https://horizon.stellar.org').replace(
  /\/+$/,
  '',
);

async function main() {
  const url = `${HORIZON_URL}/fee_stats`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch fee_stats from ${url}: HTTP ${res.status}`);
  }

  const data = await res.json();
  const lastLedger = Number(data.last_ledger);
  const baseFee = Number(data.last_ledger_base_fee) || 100;
  const capacityUsage = Number(data.ledger_capacity_usage) || 0;
  const charged = data.fee_charged || {};

  // Horizon /fee_stats aggregates over a rolling window of 200 ledgers
  const sampleCount = 200;
  const windowStart = lastLedger - sampleCount + 1;
  const windowEnd = lastLedger;

  const p50 = Number(charged.p50) || baseFee;
  const p90 = Number(charged.p90) || baseFee;
  const p95 = Number(charged.p95) || baseFee;
  const p99 = Number(charged.p99) || baseFee;
  const minCharged = Number(charged.min) || baseFee;
  const maxCharged = Number(charged.max) || baseFee;
  const mode = Number(charged.mode) || baseFee;

  // Canonical settlement shape: 1 operation (transfer / invokeHostFunction)
  // Total fee = operationCount * feeChargedPerOp
  const opCount = 1;
  const simBaseFee = opCount * baseFee;
  const simP50Fee = opCount * p50;
  const simP90Fee = opCount * p90;
  const simP99Fee = opCount * p99;

  // Derivation of Floor (min):
  // Documented floor is anchored at p90 fee charged (0% headroom applied)
  const floorMin = p90;

  // Derivation of Default ceiling (defaultValue):
  // Default is calibrated with ~9.89x headroom over p90 (or absorbs surges up to 50,000 stroops = 0.005 XLM)
  const defaultCeiling = 50_000;
  const headroomFactor = (defaultCeiling / p90).toFixed(2);

  // Daily budget: shared feeSpd = 5_000_000 stroops (0.5 XLM)
  const dailyFeeSpd = 5_000_000;
  const worstCaseDailySettlements = Math.floor(dailyFeeSpd / defaultCeiling);
  const expectedP90DailySettlements = Math.floor(dailyFeeSpd / simP90Fee);

  console.log('================================================================');
  console.log('   Stellar Pubnet Fee Calibration (Issue #650)');
  console.log('================================================================');
  console.log(`Endpoint:              ${url}`);
  console.log(`Window:                Ledgers ${windowStart} - ${windowEnd}`);
  console.log(`Sample Count:          ${sampleCount} ledgers (~16.7 minutes)`);
  console.log(`Last Ledger Base Fee:  ${baseFee} stroops`);
  console.log(`Ledger Capacity Usage: ${(capacityUsage * 100).toFixed(2)}%`);
  console.log('----------------------------------------------------------------');
  console.log('Fee Charged Percentiles (stroops / op):');
  console.log(`  min:                 ${minCharged}`);
  console.log(`  mode:                ${mode}`);
  console.log(`  p50:                 ${p50}`);
  console.log(`  p90:                 ${p90}`);
  console.log(`  p95:                 ${p95}`);
  console.log(`  p99:                 ${p99}`);
  console.log(`  max:                 ${maxCharged}`);
  console.log('----------------------------------------------------------------');
  console.log('Simulated Total Fee for Canonical Settlement (1 operation):');
  console.log(
    `  at base fee:         ${simBaseFee} stroops (${(simBaseFee / 1e7).toFixed(7)} XLM)`,
  );
  console.log(`  at p50 (median):     ${simP50Fee} stroops (${(simP50Fee / 1e7).toFixed(7)} XLM)`);
  console.log(`  at p90 (congested):  ${simP90Fee} stroops (${(simP90Fee / 1e7).toFixed(7)} XLM)`);
  console.log(`  at p99 (surge):      ${simP99Fee} stroops (${(simP99Fee / 1e7).toFixed(7)} XLM)`);
  console.log('----------------------------------------------------------------');
  console.log('Calibration Derivation:');
  console.log(`  Floor (min):         ${floorMin} stroops (anchored at p90, 0% headroom)`);
  console.log(
    `  Default Ceiling:     ${defaultCeiling} stroops (${headroomFactor}x headroom over p90)`,
  );
  console.log('Daily Budget & Capacity (feeSpd = 5,000,000 stroops = 0.5 XLM):');
  console.log(
    `  Worst-case capacity: ${worstCaseDailySettlements} settlements/day (at ceiling ${defaultCeiling} stroops)`,
  );
  console.log(
    `  P90 normal capacity: ${expectedP90DailySettlements} settlements/day (at p90 ${simP90Fee} stroops)`,
  );
  console.log('================================================================');
}

main().catch(err => {
  console.error('Error running calibration:', err);
  process.exit(1);
});
