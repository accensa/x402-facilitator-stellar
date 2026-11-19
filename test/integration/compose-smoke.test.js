/**
 * The facilitator container must be able to report on itself (#753).
 *
 * docker-compose.yml shipped seven backing services with healthchecks and no
 * healthcheck on the facilitator, so `docker compose up` reported the service as
 * started the moment the process forked — long before it could settle anything,
 * and with no restart signal if the server died. The healthcheck under test here
 * is the liveness probe (`/healthz`), not readiness: a container that is up but
 * cannot settle belongs out of a load balancer, not in a restart loop.
 *
 * This is a configuration smoke test: it parses the real docker-compose.yml with
 * the js-yaml the repo already depends on, so it needs no Docker daemon and runs
 * in `npm test` with everything offline. `docker compose config` is still the
 * authority on schema validity; this pins the semantics the issue names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const compose = loadYaml(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'));
const appSource = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

const HEALTHCHECK_URL = 'http://localhost:3402/healthz';
const HEALTHCHECK_COMMAND = `wget --no-verbose --tries=1 --spider ${HEALTHCHECK_URL} || exit 1`;

/** Compose duration literals: `5s`, `500ms`, `1m30s`. */
const DURATION = /^\d+(?:\.\d+)?(?:ns|us|ms|s|m|h)$/;

const facilitator = compose.services?.facilitator;

/** The healthcheck command as one string, without its CMD/CMD-SHELL mode token. */
function healthcheckCommand(service) {
  const value = service?.healthcheck?.test;
  const parts = (Array.isArray(value) ? value : [value]).filter(part => typeof part === 'string');
  return (parts[0] === 'CMD' || parts[0] === 'CMD-SHELL' ? parts.slice(1) : parts).join(' ');
}

test('docker-compose.yml parses and declares the facilitator service', () => {
  assert.ok(compose.services, 'docker-compose.yml must declare services');
  assert.ok(facilitator, 'docker-compose.yml must declare a facilitator service');
  assert.equal(typeof facilitator.build, 'string', 'the facilitator is built from the checkout');
});

test('the facilitator service has a healthcheck of its own', () => {
  assert.ok(
    facilitator.healthcheck,
    'the facilitator must define a healthcheck — without one `docker compose up` cannot tell a booted process from a serving one',
  );
  assert.ok(
    Array.isArray(facilitator.healthcheck.test),
    'healthcheck.test must be in list form (CMD-SHELL) so the shell `|| exit 1` is honoured',
  );
  assert.equal(facilitator.healthcheck.test[0], 'CMD-SHELL');
});

test('the healthcheck probes the liveness endpoint on the container port', () => {
  const command = healthcheckCommand(facilitator);

  assert.ok(
    command.includes(HEALTHCHECK_URL),
    `the healthcheck must target ${HEALTHCHECK_URL} — /healthz is the liveness probe with no dependency checks`,
  );
  assert.equal(
    command,
    HEALTHCHECK_COMMAND,
    'the healthcheck must use wget --no-verbose --tries=1 --spider and fail explicitly',
  );
});

test('the healthcheck does not gate on readiness or metrics', () => {
  const command = healthcheckCommand(facilitator);

  // /readyz is 503 while the signer is unfunded or RPC is unreachable: restarting
  // on that turns a dependency outage into a crash loop. /metrics is not a
  // health signal at all.
  assert.doesNotMatch(command, /\/readyz/, 'liveness must not probe /readyz');
  assert.doesNotMatch(command, /\/metrics/, 'liveness must not probe /metrics');
});

test('interval, timeout and retries are configured with Compose-valid values', () => {
  const { interval, timeout, retries, start_period: startPeriod } = facilitator.healthcheck;

  assert.match(String(interval), DURATION, 'healthcheck.interval must be a Compose duration');
  assert.match(String(timeout), DURATION, 'healthcheck.timeout must be a Compose duration');
  assert.ok(
    Number.isInteger(retries) && retries >= 1,
    'healthcheck.retries must be a positive integer',
  );
  assert.match(
    String(startPeriod),
    DURATION,
    'healthcheck.start_period must be a Compose duration — the process boots behind seven dependencies',
  );

  // The same timing conventions the backing services use; a container that takes
  // longer than this to answer /healthz is not a liveness timeout question.
  assert.equal(interval, '5s', 'interval must follow the 5s convention used by the other services');
  assert.equal(timeout, '5s', 'timeout must follow the 5s convention used by the other services');
  assert.equal(retries, 5, 'retries must follow the 5-retry convention used by the other services');
});

test('the healthcheck port is the port the facilitator publishes and listens on', () => {
  const containerPorts = facilitator.ports.map(port => String(port).split(':').pop());
  assert.ok(
    containerPorts.includes('3402'),
    'the port in the healthcheck URL must be the published container port',
  );
  assert.ok(
    facilitator.environment.includes('PORT=3402'),
    'PORT=3402 must match the healthcheck URL — otherwise the process answers somewhere else',
  );
});

test('the facilitator serves /healthz, /readyz and /metrics as the probes expect', () => {
  // /healthz: always ok while the process runs (liveness).
  assert.match(
    appSource,
    /app\.get\(\s*'\/healthz'/,
    'src/app.js must register GET /healthz — the endpoint the Compose healthcheck calls',
  );
  // /readyz: 200/503 on dependency checks (readiness, traffic gating only).
  assert.match(
    appSource,
    /app\.get\(\s*'\/readyz'/,
    'src/app.js must register GET /readyz — the readiness probe the monitoring loop calls',
  );
  // /metrics: Prometheus exposition, gated by serveMetrics (METRICS_PORT moves it
  // to a separate listener), which is why it can never be the healthcheck target.
  const metricsRouteAt = appSource.search(/app\.get\(\s*'\/metrics'/);
  const metricsGuardAt = appSource.indexOf('if (serveMetrics)');
  assert.ok(metricsRouteAt !== -1, 'src/app.js must register GET /metrics');
  assert.ok(
    metricsGuardAt !== -1 && metricsGuardAt < metricsRouteAt,
    'GET /metrics must stay behind the serveMetrics guard',
  );
});
