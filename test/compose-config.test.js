/**
 * The top-level `version` key is obsolete under Compose v2 (#730).
 *
 * Compose ignores it and prints "the attribute `version` is obsolete" on every
 * invocation. Leaving it in place adds noise to deployment output and trains
 * operators to ignore warnings. The file is a Compose Specification document,
 * not a legacy v3 one, so there is nothing for the key to select.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const compose = loadYaml(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'), {
  filename: 'docker-compose.yml',
});

test('docker-compose.yml does not declare the obsolete top-level version key', () => {
  assert.ok(compose && typeof compose === 'object', 'docker-compose.yml must parse to a mapping');
  assert.equal(
    'version' in compose,
    false,
    'remove the top-level version attribute — Compose v2 ignores it and warns on every run',
  );
});

test('docker-compose.yml defines services as a non-empty mapping', () => {
  assert.equal(typeof compose.services, 'object', 'services must be a mapping');
  assert.ok(compose.services !== null && !Array.isArray(compose.services));
  assert.ok(Object.keys(compose.services).length > 0, 'services must declare at least one service');
  assert.ok(
    compose.services.facilitator,
    'the facilitator service must remain defined after removing the version key',
  );
});
