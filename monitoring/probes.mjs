#!/usr/bin/env node
/**
 * External availability probe for the x402 facilitator (issue #19).
 *
 * Runs from OUTSIDE our own infrastructure so a silent outage on our side
 * cannot also silence its own monitor. The companion GitHub Actions workflow
 * (.github/workflows/external-monitor.yml) executes this from GitHub's runners;
 * a self-hosted deployment should point it at a separate cloud account.
 *
 * Probes (minimum set from the issue):
 *   1. GET /healthz            — liveness
 *   2. GET /readyz             — readiness (503 = cannot settle)
 *   3. GET /supported          — static config
 *   4. synthetic end-to-end payment on testnet (optional, shells out to e2e)
 *   5. signer account balance per network, alerting before the pool runs dry
 *
 * Severity: only /healthz is an incident. A failing /healthz is `down` — the
 * process is not answering, so the run fails and someone is paged. A failing
 * /readyz (up, but this instance cannot settle) or /supported (static config
 * missing) is `warn`: it is recorded on the probe result and degrades the
 * verdict to `degraded`, but it does not page. The table that encodes this is
 * PROBE_SEVERITY, next to the probe loop.
 *
 * Output: writes monitoring/out/status.json and exits non-zero if any probe
 * that is configured as "down = incident" fails. The status-page publish
 * workflow consumes status.json.
 *
 * Only Node built-ins are used so the probe has no install step of its own.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = resolve(__dirname, 'config.example.json');

// Which HTTP probe is an incident when it fails. `down` fails the run and lands
// in out.incidents; `warn` is recorded on the probe result and degrades the
// verdict. /readyz is deliberately warn: one instance refusing readiness is a
// pool member that cannot settle, not a liveness outage — the synthetic payment
// probe is the one that catches "every instance is unready".
const PROBE_SEVERITY = { healthz: 'down', readyz: 'warn', supported: 'warn' };
const HTTP_PROBES = ['healthz', 'readyz', 'supported'];

async function loadConfig() {
  const path = process.env.MONITORING_CONFIG || DEFAULT_CONFIG;
  const { readFile } = await import('node:fs/promises');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    console.error(`[probe] cannot read config ${path}: ${err.message}`);
    process.exit(2);
  }
}

function nowMs() {
  return Date.now();
}

async function timedGet(url, timeoutMs, fetchImpl = fetch) {
  const started = nowMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: nowMs() - started,
      body,
    };
  } catch (err) {
    // Connection refused / DNS / timeout / abort — a down endpoint, not a fatal error.
    return {
      ok: false,
      status: 0,
      latencyMs: nowMs() - started,
      error: err.name === 'AbortError' ? 'timeout' : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function runCommand(cmd, timeoutMs) {
  return new Promise(resolve => {
    const started = nowMs();
    const [bin, ...args] = cmd.split(/\s+/);
    const child = spawn(bin, args, { env: process.env });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, latencyMs: nowMs() - started, output: out });
    });
    child.on('error', err =>
      resolve({ ok: false, code: -1, latencyMs: nowMs() - started, output: String(err) }),
    );
  });
}

async function probeSignerBalance(signers, horizonUrl, timeoutMs, fetchImpl = fetch) {
  const results = [];
  for (const s of signers) {
    const started = nowMs();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetchImpl(`${horizonUrl}/accounts/${s.address}`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const latencyMs = nowMs() - started;
      if (!res.ok) {
        results.push({
          address: s.address,
          network: s.network,
          ok: false,
          status: res.status,
          latencyMs,
          level: 'down',
        });
        continue;
      }
      const acct = await res.json();
      const xlm = acct.balances?.find(b => b.asset_type === 'native');
      const stroops = xlm ? Math.round(Number(xlm.balance) * 1e7) : 0;
      let level = 'ok';
      if (stroops < (s.signalFloorStroops ?? 0)) level = 'down';
      else if (stroops < (s.warnFloorStroops ?? 0)) level = 'warn';
      results.push({
        address: s.address,
        network: s.network,
        ok: true,
        balanceStroops: stroops,
        warnFloorStroops: s.warnFloorStroops ?? 0,
        signalFloorStroops: s.signalFloorStroops ?? 0,
        level,
        latencyMs,
      });
    } catch (err) {
      results.push({
        address: s.address,
        network: s.network,
        ok: false,
        error: err.message,
        latencyMs: nowMs() - started,
        level: 'down',
      });
    }
  }
  return results;
}

/**
 * Runs the configured probes and returns the report `main` writes to
 * status.json.
 *
 * Exported so the probe loop can be tested with an injected `fetchImpl` /
 * `runCommandImpl`: `npm test` runs offline, so a test must never reach the
 * network or spawn the end-to-end script.
 */
export async function runProbes({
  config,
  fetchImpl = fetch,
  runCommandImpl = runCommand,
  env = process.env,
} = {}) {
  const endpoint = (env.FACILITATOR_URL || config.endpoint || 'http://localhost:3402').replace(
    /\/$/,
    '',
  );
  const timeoutMs = config.timeoutMs ?? 5000;

  // SYNTHETIC_PAYMENT=true (set by the external-monitor workflow) turns on the
  // end-to-end testnet payment probe without needing a separate config file.
  const synthetic = config.probe?.syntheticPayment;
  const syntheticEnabled =
    Boolean(synthetic) && (synthetic.enabled === true || env.SYNTHETIC_PAYMENT === 'true');

  const out = {
    generatedAt: new Date().toISOString(),
    endpoint,
    probes: {},
    incidents: [],
  };

  // 1-3: HTTP probes
  for (const name of HTTP_PROBES) {
    if (config.probe?.[name] === false) continue;
    const r = await timedGet(`${endpoint}/${name}`, timeoutMs, fetchImpl);
    const warnMs = config.thresholds?.latencyWarnMs?.[name];
    const failureLevel = PROBE_SEVERITY[name] ?? 'warn';
    let level = 'ok';
    if (!r.ok) level = failureLevel;
    else if (warnMs && r.latencyMs > warnMs) level = 'warn';
    out.probes[name] = { ok: r.ok, status: r.status, latencyMs: r.latencyMs, level };
    // Only an incident-level failure is an incident; a `warn` stays on the
    // probe result and turns the verdict below into `degraded`.
    if (level === 'down') out.incidents.push({ probe: name, level, detail: `HTTP ${r.status}` });
  }

  // 4: synthetic end-to-end payment (optional)
  if (syntheticEnabled) {
    const r = await runCommandImpl(
      synthetic.command || 'node scripts/e2e.mjs',
      synthetic.timeoutMs ?? 60000,
    );
    out.probes.syntheticPayment = {
      ok: r.ok,
      code: r.code,
      latencyMs: r.latencyMs,
      level: r.ok ? 'ok' : 'down',
    };
    if (!r.ok)
      out.incidents.push({ probe: 'syntheticPayment', level: 'down', detail: `exit ${r.code}` });
  }

  // 5: signer balance
  if (config.probe?.signerBalance?.enabled) {
    const balances = await probeSignerBalance(
      config.probe.signerBalance.signers || [],
      config.probe.signerBalance.horizonUrl || 'https://horizon-testnet.stellar.org',
      timeoutMs,
      fetchImpl,
    );
    out.probes.signerBalance = balances;
    for (const b of balances) {
      if (b.level === 'down')
        out.incidents.push({
          probe: 'signerBalance',
          level: 'down',
          detail: `${b.address} (${b.network})`,
        });
      else if (b.level === 'warn')
        out.incidents.push({
          probe: 'signerBalance',
          level: 'warn',
          detail: `${b.address} (${b.network})`,
        });
    }
  }

  // A `warn` that is not an incident (a slow / a not-ready / a missing
  // /supported) still has to degrade the verdict, or a /readyz 503 would be
  // reported as operational.
  const probeLevels = Object.values(out.probes).flatMap(probe =>
    Array.isArray(probe) ? probe.map(s => s.level) : [probe.level],
  );
  const hasDown = out.incidents.some(i => i.level === 'down');
  const hasWarn = out.incidents.some(i => i.level === 'warn') || probeLevels.includes('warn');
  out.status = hasDown ? 'down' : hasWarn ? 'degraded' : 'operational';

  return out;
}

async function main() {
  const cfg = await loadConfig();
  const out = await runProbes({ config: cfg });

  const outPath = resolve(__dirname, 'out', 'status.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[probe] status=${out.status} incidents=${out.incidents.length} -> ${outPath}`);
  process.exit(out.status === 'down' ? 1 : 0);
}

// Only run the probes when this file is the entry point. Importing it (as the
// tests do) must not probe anything, write status.json, or exit the process.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(err => {
    console.error(`[probe] fatal: ${err.message}`);
    process.exit(2);
  });
}
