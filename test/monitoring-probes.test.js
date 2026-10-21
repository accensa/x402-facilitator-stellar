/**
 * monitoring/probes.mjs — the HTTP probe loop's severity assignment.
 *
 * The bug this pins: `level = name === 'healthz' ? 'down' : 'down'` selected
 * between two identical literals, so a /readyz or /supported failure was paged
 * exactly like a liveness outage. The levels under test are now
 *
 *   /healthz   failing => down => out.incidents, verdict `down`, exit non-zero
 *   /readyz    failing => warn => no incident, verdict `degraded`
 *   /supported failing => warn => no incident, verdict `degraded`
 *   any probe  slow but 2xx => warn, no incident
 *
 * Every case injects its own fetch: `npm test` runs offline, so nothing here
 * reaches the network or spawns the end-to-end payment script.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbes } from '../monitoring/probes.mjs';

const OK = 200;
const UNAVAILABLE = 503;

/** Minimal Response stand-in — timedGet only reads ok, status and text(). */
function response(status) {
  return { ok: status >= 200 && status < 300, status, text: async () => '{}' };
}

/**
 * fetch stub: probe name -> { status, delayMs }, defaulting to 200. Records the
 * URLs it was asked for so a test can prove which probes ran.
 */
function stubFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const name = new URL(url).pathname.replace(/^\//, '');
    const route = { status: OK, ...routes[name] };
    // A real delay, because latency is measured with Date.now(): a threshold of
    // 1ms and a 20ms response makes the warn path deterministic without fake
    // timers.
    if (route.delayMs) await new Promise(resolve => setTimeout(resolve, route.delayMs));
    return response(route.status);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function config(overrides = {}) {
  return {
    endpoint: 'https://facilitator.test',
    timeoutMs: 1000,
    probe: { healthz: true, readyz: true, supported: true, ...overrides.probe },
    thresholds: { latencyWarnMs: { ...overrides.latencyWarnMs } },
  };
}

async function probe(overrides = {}, env = {}) {
  const fetchImpl = stubFetch(overrides.routes);
  const report = await runProbes({ config: config(overrides), fetchImpl, env });
  return { report, fetchImpl };
}

describe('runProbes: HTTP probe severity', () => {
  test('three healthy probes: no incidents, operational', async () => {
    const { report, fetchImpl } = await probe();

    assert.deepEqual(fetchImpl.calls, [
      'https://facilitator.test/healthz',
      'https://facilitator.test/readyz',
      'https://facilitator.test/supported',
    ]);
    for (const name of ['healthz', 'readyz', 'supported']) {
      assert.equal(report.probes[name].level, 'ok', `${name} level`);
      assert.equal(report.probes[name].ok, true);
    }
    assert.deepEqual(report.incidents, []);
    assert.equal(report.status, 'operational');
  });

  test('a failing /healthz is down and is the only incident', async () => {
    const { report } = await probe({ routes: { healthz: { status: UNAVAILABLE } } });

    assert.equal(report.probes.healthz.level, 'down');
    assert.equal(report.probes.readyz.level, 'ok');
    assert.deepEqual(report.incidents, [{ probe: 'healthz', level: 'down', detail: 'HTTP 503' }]);
    assert.equal(report.status, 'down');
  });

  test('a failing /readyz is warn: no incident, degraded verdict', async () => {
    const { report } = await probe({ routes: { readyz: { status: UNAVAILABLE } } });

    // Not `down`: one unready instance does not mean the process is gone, so it
    // must not page the way /healthz does.
    assert.equal(report.probes.readyz.level, 'warn');
    assert.equal(report.probes.healthz.level, 'ok');
    assert.deepEqual(report.incidents, [], 'warn-level probe must not raise an incident');
    assert.equal(report.status, 'degraded');
  });

  test('a failing /supported is warn: no incident, degraded verdict', async () => {
    const { report } = await probe({ routes: { supported: { status: UNAVAILABLE } } });

    assert.equal(report.probes.supported.level, 'warn');
    assert.deepEqual(report.incidents, []);
    assert.equal(report.status, 'degraded');
  });

  test('a slow but healthy probe is warn, and stays out of incidents', async () => {
    const { report } = await probe({
      routes: { readyz: { delayMs: 20 } },
      latencyWarnMs: { readyz: 1 },
    });

    // The request succeeded, so this is the latency path, not a failure path.
    assert.equal(report.probes.readyz.ok, true);
    assert.equal(report.probes.readyz.status, OK);
    assert.ok(report.probes.readyz.latencyMs >= 20);
    assert.equal(report.probes.readyz.level, 'warn');
    assert.deepEqual(report.incidents, []);
    assert.equal(report.status, 'degraded');
  });

  test('an unreachable /healthz is down with HTTP 0, not a fatal error', async () => {
    const fetchImpl = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' });
    };
    const report = await runProbes({ config: config(), fetchImpl, env: {} });

    assert.equal(report.probes.healthz.status, 0);
    assert.equal(report.probes.healthz.level, 'down');
    assert.deepEqual(report.incidents, [{ probe: 'healthz', level: 'down', detail: 'HTTP 0' }]);
    assert.equal(report.status, 'down');
  });
});

describe('runProbes: synthetic payment', () => {
  test('SYNTHETIC_PAYMENT=true runs the payment probe and a failure is an incident', async () => {
    const commands = [];
    const report = await runProbes({
      config: config({
        probe: {
          syntheticPayment: {
            enabled: false,
            command: 'node scripts/e2e.mjs',
            timeoutMs: 60000,
          },
        },
      }),
      fetchImpl: stubFetch(),
      env: { SYNTHETIC_PAYMENT: 'true' },
      runCommandImpl: async (command, timeoutMs) => {
        commands.push({ command, timeoutMs });
        return { ok: false, code: 3, latencyMs: 1200, output: 'payment failed' };
      },
    });

    assert.deepEqual(commands, [{ command: 'node scripts/e2e.mjs', timeoutMs: 60000 }]);
    assert.deepEqual(report.probes.syntheticPayment, {
      ok: false,
      code: 3,
      latencyMs: 1200,
      level: 'down',
    });
    assert.deepEqual(report.incidents, [
      { probe: 'syntheticPayment', level: 'down', detail: 'exit 3' },
    ]);
    assert.equal(report.status, 'down');
  });

  test('the synthetic payment probe stays off without SYNTHETIC_PAYMENT', async () => {
    let ran = false;
    const report = await runProbes({
      config: config({
        probe: { syntheticPayment: { enabled: false, command: 'node scripts/e2e.mjs' } },
      }),
      fetchImpl: stubFetch(),
      env: {},
      runCommandImpl: async () => {
        ran = true;
        return { ok: true, code: 0, latencyMs: 1, output: '' };
      },
    });

    assert.equal(ran, false, 'an unenabled synthetic probe must not spawn anything');
    assert.equal(report.probes.syntheticPayment, undefined);
    assert.deepEqual(report.incidents, []);
    assert.equal(report.status, 'operational');
  });

  test('enabled: true in config runs it without the env flag, and success is ok', async () => {
    const report = await runProbes({
      config: config({
        probe: { syntheticPayment: { enabled: true, command: 'node scripts/e2e.mjs' } },
      }),
      fetchImpl: stubFetch(),
      env: {},
      runCommandImpl: async () => ({ ok: true, code: 0, latencyMs: 900, output: '' }),
    });

    assert.equal(report.probes.syntheticPayment.level, 'ok');
    assert.deepEqual(report.incidents, []);
    assert.equal(report.status, 'operational');
  });
});
