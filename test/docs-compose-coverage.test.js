/**
 * Every compose file at the repo root must be documented (#750).
 *
 * `docker-compose.yml` was introduced by docs/DEPLOYMENT.md and stayed
 * documented; `docker-compose.multi-region.yml` (#126) shipped with usage only
 * in its own header comment, so an operator reading the deployment runbook had
 * no idea a failover fixture existed. Nothing caught it because nothing
 * asserted on the set of compose files. This does: any `docker-compose*.yml`
 * (or `.yaml`) file added at the root fails CI until DEPLOYMENT.md names it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE_FILE_RE = /^docker-compose.*\.ya?ml$/;
const deployment = readFileSync(join(ROOT, 'docs', 'DEPLOYMENT.md'), 'utf8');

/** Root-level compose files, as an operator would find them. */
const composeFiles = readdirSync(ROOT)
  .filter(name => COMPOSE_FILE_RE.test(name))
  .sort();

test('the repo root ships at least one compose file', () => {
  assert.ok(
    composeFiles.length > 0,
    'no docker-compose*.yml file found at the repo root — this test has nothing to check',
  );
});

test('every compose file at the repo root is named in docs/DEPLOYMENT.md', () => {
  const undocumented = composeFiles.filter(name => !deployment.includes(name));
  assert.deepEqual(
    undocumented,
    [],
    `docs/DEPLOYMENT.md does not document ${undocumented.join(', ')} — add a section ` +
      'that introduces the file, its services and its environment variables, so the ' +
      'runbook covers every way this repo can be deployed',
  );
});
