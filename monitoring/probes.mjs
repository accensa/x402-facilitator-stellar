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
 * Output: writes monitoring/out/status.json and exits non-zero if any probe
 * that is configured as "down = incident" fails. The status-page publish
 * workflow consumes status.json.
 *
 * Only Node built-ins are used so the probe has no install step of its own.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = resolve(__dirname, 'config.example.json');

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

async function timedGet(url, timeoutMs) {
  const started = nowMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
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

async function probeSignerBalance(signers, horizonUrl, timeoutMs) {
  const results = [];
  for (const s of signers) {
    const started = nowMs();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${horizonUrl}/accounts/${s.address}`, { signal: ctrl.signal });
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

async function main() {
  const cfg = await loadConfig();
  const endpoint = (process.env.FACILITATOR_URL || cfg.endpoint || 'http://localhost:3402').replace(
    /\/$/,
    '',
  );
  const timeoutMs = cfg.timeoutMs ?? 5000;

  // SYNTHETIC_PAYMENT=true (set by the external-monitor workflow) turns on the
  // end-to-end testnet payment probe without needing a separate config file.
  if (process.env.SYNTHETIC_PAYMENT === 'true' && cfg.probe?.syntheticPayment) {
    cfg.probe.syntheticPayment.enabled = true;
  }
  const out = {
    generatedAt: new Date().toISOString(),
    endpoint,
    probes: {},
    incidents: [],
  };

  // 1-3: HTTP probes
  for (const name of ['healthz', 'readyz', 'supported']) {
    if (cfg.probe?.[name] === false) continue;
    const r = await timedGet(`${endpoint}/${name}`, timeoutMs);
    const warnMs = cfg.thresholds?.latencyWarnMs?.[name];
    let level = 'ok';
    if (!r.ok) level = name === 'healthz' ? 'down' : 'down';
    else if (warnMs && r.latencyMs > warnMs) level = 'warn';
    out.probes[name] = { ok: r.ok, status: r.status, latencyMs: r.latencyMs, level };
    if (level === 'down') out.incidents.push({ probe: name, level, detail: `HTTP ${r.status}` });
  }

  // 4: synthetic end-to-end payment (optional)
  if (cfg.probe?.syntheticPayment?.enabled) {
    const r = await runCommand(
      cfg.probe.syntheticPayment.command || 'node scripts/e2e.mjs',
      cfg.probe.syntheticPayment.timeoutMs ?? 60000,
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
  if (cfg.probe?.signerBalance?.enabled) {
    const balances = await probeSignerBalance(
      cfg.probe.signerBalance.signers || [],
      cfg.probe.signerBalance.horizonUrl || 'https://horizon-testnet.stellar.org',
      timeoutMs,
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

  const hasDown = out.incidents.some(i => i.level === 'down');
  const hasWarn = out.incidents.some(i => i.level === 'warn');
  out.status = hasDown ? 'down' : hasWarn ? 'degraded' : 'operational';

  const outPath = resolve(__dirname, 'out', 'status.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[probe] status=${out.status} incidents=${out.incidents.length} -> ${outPath}`);
  process.exit(hasDown ? 1 : 0);
}

main().catch(err => {
  console.error(`[probe] fatal: ${err.message}`);
  process.exit(2);
});
