/**
 * Pins the signer-balance threshold precedence in `monitoring/probes.mjs`
 * (#748):
 *
 *   if (stroops < (s.signalFloorStroops ?? 0)) level = 'down';
 *   else if (stroops < (s.warnFloorStroops ?? 0)) level = 'warn';
 *
 * The `signalFloorStroops` check must stay first: a critically depleted signer
 * reported as a mere `warn` is a missed incident. Omitted floors default to 0
 * via `?? 0`, so an unconfigured signer is `ok` rather than perpetually `warn`.
 *
 * `monitoring/probes.mjs` is a executable script, not a library: importing it
 * would run `main()` and `process.exit`. The test therefore runs it as a child
 * process against a stub Horizon server and the real `status.json` it writes,
 * which exercises the actual probe rather than a copy of its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBES_PATH = join(ROOT, 'monitoring', 'probes.mjs');
const STATUS_PATH = join(ROOT, 'monitoring', 'out', 'status.json');

const SIGNAL_FLOOR = 10_000_000; // 1 XLM
const WARN_FLOOR = 50_000_000; // 5 XLM

// One signer per branch of the threshold ladder. `balance` is XLM as Horizon
// reports it; `expectedStroops` is what the probe should compute from it.
const CASES = [
  {
    address: 'GBELOWSIGNAL',
    why: 'below the critical signal floor',
    balance: '0.5000000',
    signalFloorStroops: SIGNAL_FLOOR,
    warnFloorStroops: WARN_FLOOR,
    expectedStroops: 5_000_000,
    expectedLevel: 'down',
  },
  {
    address: 'GBETWEENFLOORS',
    why: 'between the signal and warning floors',
    balance: '2.5000000',
    signalFloorStroops: SIGNAL_FLOOR,
    warnFloorStroops: WARN_FLOOR,
    expectedStroops: 25_000_000,
    expectedLevel: 'warn',
  },
  {
    address: 'GABOVEWARN',
    why: 'above the warning floor',
    balance: '12.0000000',
    signalFloorStroops: SIGNAL_FLOOR,
    warnFloorStroops: WARN_FLOOR,
    expectedStroops: 120_000_000,
    expectedLevel: 'ok',
  },
  {
    address: 'GATEXACTLYSIGNAL',
    why: 'exactly on the signal floor (the comparison is strict `<`)',
    balance: '1.0000000',
    signalFloorStroops: SIGNAL_FLOOR,
    warnFloorStroops: WARN_FLOOR,
    expectedStroops: SIGNAL_FLOOR,
    expectedLevel: 'warn',
  },
  {
    address: 'GATEXACTLYWARN',
    why: 'exactly on the warning floor (the comparison is strict `<`)',
    balance: '5.0000000',
    signalFloorStroops: SIGNAL_FLOOR,
    warnFloorStroops: WARN_FLOOR,
    expectedStroops: WARN_FLOOR,
    expectedLevel: 'ok',
  },
  {
    address: 'GNOFLOORS',
    why: 'no floors configured, so `?? 0` applies to both',
    balance: '0.0000000',
    expectedStroops: 0,
    expectedLevel: 'ok',
  },
  {
    address: 'GINVERTEDFLOORS',
    why: 'inverted floors — the signal check must still win',
    balance: '0.7000000',
    signalFloorStroops: SIGNAL_FLOOR,
    warnFloorStroops: 5_000_000,
    expectedStroops: 7_000_000,
    expectedLevel: 'down',
  },
];

function startHorizonStub() {
  const byAddress = new Map(CASES.map(entry => [entry.address, entry.balance]));
  const server = createServer((req, res) => {
    const match = (req.url ?? '').match(/^\/accounts\/([^/?]+)$/);
    const address = match?.[1];
    if (!address || !byAddress.has(address)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 404, title: 'Resource Missing' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        account_id: address,
        balances: [
          // A non-native balance first: the probe must pick the native one.
          { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '999.0000000' },
          { asset_type: 'native', balance: byAddress.get(address) },
        ],
      }),
    );
  });
  return server;
}

function runProbe(configPath) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PROBES_PATH], {
      cwd: ROOT,
      env: { ...process.env, MONITORING_CONFIG: configPath },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', err => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('signer balance levels follow signal-floor-before-warn-floor precedence', async t => {
  const server = startHorizonStub();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const horizonUrl = `http://127.0.0.1:${server.address().port}`;

  const workDir = mkdtempSync(join(tmpdir(), 'x402-probe-balance-'));
  t.after(async () => {
    rmSync(workDir, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  });

  const config = {
    endpoint: horizonUrl,
    timeoutMs: 5000,
    probe: {
      // The HTTP and synthetic probes are out of scope here; disabling them
      // keeps this test to the signer-balance branch.
      healthz: false,
      readyz: false,
      supported: false,
      syntheticPayment: { enabled: false },
      signerBalance: {
        enabled: true,
        horizonUrl,
        signers: CASES.map(entry => ({
          address: entry.address,
          network: 'stellar:testnet',
          ...(entry.signalFloorStroops === undefined
            ? {}
            : { signalFloorStroops: entry.signalFloorStroops }),
          ...(entry.warnFloorStroops === undefined
            ? {}
            : { warnFloorStroops: entry.warnFloorStroops }),
        })),
      },
    },
  };
  const configPath = join(workDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const result = await runProbe(configPath);
  // At least one case is `down`, and the probe exits non-zero for an incident.
  assert.equal(
    result.code,
    1,
    `probe exited ${result.code}; expected 1 for a down incident\n${result.stdout}${result.stderr}`,
  );

  const status = JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
  const balances = new Map(
    (status.probes?.signerBalance ?? []).map(entry => [entry.address, entry]),
  );

  for (const entry of CASES) {
    const observed = balances.get(entry.address);
    assert.ok(observed, `no signerBalance result for ${entry.address} (${entry.why})`);
    assert.equal(observed.ok, true, `${entry.address}: Horizon account fetch failed`);
    assert.equal(observed.level, entry.expectedLevel, `${entry.address}: ${entry.why}`);
    assert.equal(observed.balanceStroops, entry.expectedStroops, `${entry.address}: stroop math`);
    assert.equal(observed.warnFloorStroops, entry.warnFloorStroops ?? 0);
    assert.equal(observed.signalFloorStroops, entry.signalFloorStroops ?? 0);
  }

  // The ladder must also surface as incidents, not just as per-signer levels.
  const incidents = status.incidents.filter(incident => incident.probe === 'signerBalance');
  for (const entry of CASES) {
    const incident = incidents.find(item => item.detail.includes(entry.address));
    if (entry.expectedLevel === 'ok') {
      assert.equal(incident, undefined, `${entry.address}: should not raise an incident`);
    } else {
      assert.equal(incident?.level, entry.expectedLevel, `${entry.address}: incident level`);
    }
  }
  assert.equal(status.status, 'down', 'a down signer must make the overall status down');
});
