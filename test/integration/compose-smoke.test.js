/**
 * `docker-compose.yml` must let a harness wait for the facilitator (#753).
 *
 * The facilitator service declared no healthcheck while every backing service
 * did, so `docker compose up --wait` had nothing to wait on for the service
 * actually under test: integration scripts fell back to sleep loops and polling
 * shims. This pins the healthcheck's placement, its target and its timings, and
 * the endpoint contract it relies on.
 *
 * The compose file is *parsed* with js-yaml (already a dev dependency, used by
 * test/openapi.test.js), not pattern-matched, so a healthcheck added under a
 * dependency, a command that no longer targets /healthz, or a timing that has
 * drifted from the image all fail here. No Docker daemon is required: this is a
 * configuration smoke test, and it stays deterministic and offline.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { OPERATIONAL_ROUTES } from '../../src/app.js';

const ROOT = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, ROOT), 'utf8').replace(/\r/g, '');

const compose = loadYaml(read('docker-compose.yml'));
const services = compose?.services ?? {};
const facilitator = services.facilitator;
const healthcheck = facilitator?.healthcheck;

const HEALTHCHECK_URL = 'http://localhost:3402/healthz';
const HEALTHCHECK_COMMAND = `wget --no-verbose --tries=1 --spider ${HEALTHCHECK_URL} || exit 1`;

describe('docker-compose: facilitator service healthcheck (#753)', () => {
  test('the compose file parses and defines the facilitator service', () => {
    assert.equal(typeof compose, 'object');
    assert.ok(Object.keys(services).length > 0, 'docker-compose.yml must define services');
    assert.ok(facilitator, 'the facilitator service must exist');
    // The healthcheck must not have cost the published port.
    assert.deepEqual(facilitator.ports, ['${PORT:-3402}:3402']);
  });

  test('the facilitator service declares a healthcheck', () => {
    assert.ok(
      healthcheck,
      'facilitator must declare a healthcheck — without one, `docker compose up --wait` ' +
        'cannot tell when the service is ready to receive traffic',
    );
    assert.ok(Array.isArray(healthcheck.test), 'healthcheck.test must be a command list');
    assert.equal(healthcheck.disable, undefined, 'the healthcheck must not be disabled');
  });

  test('the healthcheck targets http://localhost:3402/healthz', () => {
    assert.ok(
      healthcheck.test.some(part => String(part).includes(HEALTHCHECK_URL)),
      `healthcheck must probe ${HEALTHCHECK_URL}`,
    );
    // Liveness, not readiness: /readyz fails on a downstream Soroban RPC outage,
    // and a Docker-level check on that would restart-loop the container without
    // fixing anyone else's RPC (see the HEALTHCHECK comment in the Dockerfile).
    assert.equal(
      JSON.stringify(healthcheck.test).includes('/readyz'),
      false,
      'the container healthcheck must target /healthz (liveness), not /readyz (traffic gating)',
    );
  });

  test('the healthcheck uses the expected wget command', () => {
    assert.deepEqual(healthcheck.test, ['CMD-SHELL', HEALTHCHECK_COMMAND]);
  });

  test('interval, timeout, retries and start period are configured', () => {
    const duration = /^\d+(?:\.\d+)?(?:ms|s|m|h)$/;
    for (const name of ['interval', 'timeout', 'start_period']) {
      assert.match(
        String(healthcheck[name]),
        duration,
        `healthcheck.${name} must be a compose duration, got ${JSON.stringify(healthcheck[name])}`,
      );
    }
    assert.equal(typeof healthcheck.retries, 'number');
    assert.ok(healthcheck.retries >= 1, 'healthcheck.retries must allow at least one retry');
  });

  test('the timings agree with the image HEALTHCHECK they mirror', () => {
    const dockerfile = read('Dockerfile');
    // The flags live on the HEALTHCHECK line; the command follows on a
    // continuation line, so only that line is compared here.
    const flags = dockerfile.match(/^HEALTHCHECK.*$/m)?.[0] ?? '';
    assert.ok(flags, 'the Dockerfile must declare its own HEALTHCHECK');
    for (const [composeKey, flag] of [
      ['interval', 'interval'],
      ['timeout', 'timeout'],
      ['start_period', 'start-period'],
      ['retries', 'retries'],
    ]) {
      assert.ok(
        flags.includes(`--${flag}=${healthcheck[composeKey]}`),
        `Dockerfile HEALTHCHECK ${flag} must match compose healthcheck.${composeKey}`,
      );
    }
    assert.match(dockerfile, /--spider http:\/\/localhost:\$\{PORT:-3402\}\/healthz/);
  });

  test('no backing service carries the facilitator probe', () => {
    for (const [name, service] of Object.entries(services)) {
      if (name === 'facilitator') continue;
      const command = JSON.stringify(service?.healthcheck?.test ?? '');
      assert.equal(
        command.includes('3402'),
        false,
        `${name} must not inherit the facilitator healthcheck — it is defined under the ` +
          'facilitator service only',
      );
    }
    // The dependencies still carry their own probes; the new block did not move them.
    for (const name of [
      'db',
      'db-replica',
      'redis',
      'redis-node-1',
      'redis-node-2',
      'redis-node-3',
    ]) {
      assert.ok(services[name]?.healthcheck, `${name} must keep its own healthcheck`);
    }
  });
});

describe('facilitator probe endpoint expectations (#753)', () => {
  test('/healthz, /readyz and /metrics stay operational routes the app serves', () => {
    for (const route of ['/healthz', '/readyz', '/metrics']) {
      assert.ok(OPERATIONAL_ROUTES.has(route), `${route} must stay an operational route`);
    }
    const app = read('src/app.js');
    for (const route of ['/healthz', '/readyz', '/metrics']) {
      assert.ok(
        app.includes(`app.get('${route}'`),
        `${route} is expected by the healthcheck/probes but is not registered in src/app.js`,
      );
    }
  });

  test('/healthz is liveness (no dependencies) while /readyz gates traffic', () => {
    const app = read('src/app.js');
    // Liveness answers { ok: true } unconditionally — which is what makes it
    // safe to restart on. Readiness is where dependency checks live.
    assert.match(app, /app\.get\('\/healthz',\s*async\s*\(\)\s*=>\s*\(\{\s*ok:\s*true\s*\}\)\)/);
    assert.match(app, /app\.get\('\/readyz'/);
  });
});
