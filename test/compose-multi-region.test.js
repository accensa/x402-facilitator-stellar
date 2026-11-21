import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const COMPOSE_FILE = 'docker-compose.multi-region.yml';
const COMPOSE_PATH = fileURLToPath(new URL('../docker-compose.multi-region.yml', import.meta.url));
const RAW_COMPOSE = readFileSync(COMPOSE_PATH, 'utf8');

const FACILITATORS = ['facilitator-us-east-1', 'facilitator-eu-west-1'];
const BACKING_SERVICES = [
  'db',
  'redis-us-east',
  'redis-node-us-east-1',
  'redis-node-us-east-2',
  'redis-node-us-east-3',
  'redis-eu-west',
  'redis-node-eu-west-1',
  'redis-node-eu-west-2',
  'redis-node-eu-west-3',
];
const REDIS_SERVICES = BACKING_SERVICES.filter(name => name !== 'db');

function parseCompose(raw) {
  let document;
  try {
    document = loadYaml(raw, { filename: COMPOSE_FILE });
  } catch (error) {
    assert.fail(`${COMPOSE_FILE} is not valid YAML: ${error.message}`);
  }
  assert.ok(
    document && typeof document === 'object' && !Array.isArray(document),
    `${COMPOSE_FILE} must parse to a YAML mapping`,
  );
  return document;
}

const compose = parseCompose(RAW_COMPOSE);

function dependencyProblems(services) {
  const problems = [];
  for (const [name, service] of Object.entries(services)) {
    const dependsOn = service?.depends_on;
    if (dependsOn === undefined) continue;

    let dependencies;
    if (Array.isArray(dependsOn)) {
      dependencies = dependsOn;
    } else if (dependsOn && typeof dependsOn === 'object') {
      dependencies = Object.keys(dependsOn);
    } else {
      problems.push(`${name}.depends_on must be a list or a mapping of service names`);
      continue;
    }

    for (const dependency of dependencies) {
      if (typeof dependency !== 'string' || !Object.hasOwn(services, dependency)) {
        problems.push(`${name}.depends_on references undeclared service "${dependency}"`);
      }
    }
  }
  return problems;
}

function healthcheckProblems(services) {
  const problems = [];
  for (const [name, service] of Object.entries(services)) {
    const healthcheck = service?.healthcheck;
    if (!healthcheck || typeof healthcheck !== 'object' || Array.isArray(healthcheck)) {
      problems.push(`${name} declares no healthcheck`);
      continue;
    }
    const command = Array.isArray(healthcheck.test) ? healthcheck.test.join(' ') : healthcheck.test;
    if (typeof command !== 'string' || command.trim() === '') {
      problems.push(`${name} healthcheck.test must declare a probe command`);
    }
    for (const field of ['interval', 'timeout', 'retries']) {
      if (healthcheck[field] === undefined || healthcheck[field] === null) {
        problems.push(`${name} healthcheck is missing ${field}`);
      }
    }
  }
  return problems;
}

test('docker-compose.multi-region.yml parses as a YAML mapping with services', () => {
  assert.ok(
    compose.services && typeof compose.services === 'object' && !Array.isArray(compose.services),
    `${COMPOSE_FILE} must declare services as a mapping`,
  );
  assert.ok(Object.keys(compose.services).length > 0, `${COMPOSE_FILE} must declare services`);
});

test('the documented multi-region topology is declared', () => {
  for (const name of [...FACILITATORS, ...BACKING_SERVICES]) {
    assert.ok(
      Object.hasOwn(compose.services, name),
      `${COMPOSE_FILE} must declare service "${name}"`,
    );
  }
});

test('every depends_on reference resolves to a declared service (#746)', () => {
  const problems = dependencyProblems(compose.services);
  assert.deepEqual(
    problems,
    [],
    `Broken depends_on references in ${COMPOSE_FILE}:\n${problems.join('\n')}`,
  );
});

test('every multi-region service declares a usable healthcheck (#746)', () => {
  const problems = healthcheckProblems(compose.services);
  assert.deepEqual(
    problems,
    [],
    `Missing or unusable healthchecks in ${COMPOSE_FILE}:\n${problems.join('\n')}`,
  );
});

test('regional infrastructure and facilitators probe the right endpoints', () => {
  const command = name => {
    const probe = compose.services[name].healthcheck.test;
    return (Array.isArray(probe) ? probe : [probe]).join(' ');
  };

  assert.match(command('db'), /pg_isready/, 'db must be probed with pg_isready');
  for (const name of REDIS_SERVICES) {
    assert.match(command(name), /redis-cli ping/, `${name} must be probed with redis-cli ping`);
  }
  for (const name of FACILITATORS) {
    assert.match(command(name), /\/healthz/, `${name} must probe the liveness endpoint`);
    assert.doesNotMatch(command(name), /\/readyz/, `${name} must not gate on readiness`);
  }
});

test('the compose validators catch corrupted configuration', () => {
  assert.throws(() => parseCompose('services:\n  db: [oops\n'), /not valid YAML/);
  assert.throws(() => parseCompose('services:\n  db: *missing\n'), /not valid YAML/);

  const broken = JSON.parse(JSON.stringify(compose.services));
  broken['facilitator-eu-west-1'].depends_on['ghost-service'] = { condition: 'service_healthy' };
  delete broken['redis-us-east'].healthcheck;

  assert.ok(
    dependencyProblems(broken).some(problem => problem.includes('ghost-service')),
    'validator must reject depends_on entries for undeclared services',
  );
  assert.ok(
    healthcheckProblems(broken).some(problem => problem.includes('redis-us-east')),
    'validator must reject services without a healthcheck',
  );
});
