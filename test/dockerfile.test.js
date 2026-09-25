/**
 * The image must be able to do what the deployment runbook says it can (#211).
 *
 * docs/DEPLOYMENT.md documents `node scripts/db-migrate.js up && node
 * src/server.js` as a container entrypoint, and scripts/db-migrate.js resolves
 * `../migrations` relative to its own file. The Dockerfile copied only `src/`,
 * so a released image built, booted and served — and then failed every
 * migration command in the runbook on a missing path. Nothing caught it because
 * nothing asserted on the shipped contents. This does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const deployment = readFileSync(join(ROOT, 'docs', 'DEPLOYMENT.md'), 'utf8');

/**
 * True when some `COPY` instruction copies the repository directory `dir` into
 * the same path inside the image (flags like --chown/--from are ignored).
 */
function copiesDir(dir) {
  return dockerfile.split('\n').some(line => {
    const instruction = line.match(/^\s*COPY\s+(.+)$/);
    if (!instruction) return false;
    const args = instruction[1]
      .split(/\s+/)
      .filter(token => token.length > 0 && !token.startsWith('--'));
    if (args.length !== 2) return false;
    const [source, destination] = args;
    return (
      source.replace(/\/$/, '') === dir &&
      destination.replace(/^\.\//, '').replace(/\/$/, '') === dir
    );
  });
}

test('the image copies scripts/ into the same path it is documented at', () => {
  assert.ok(
    copiesDir('scripts'),
    'Dockerfile must COPY scripts/ ./scripts/ — the runbook runs `node scripts/db-migrate.js up`',
  );
});

test('the image copies migrations/ into the same path db-migrate.js resolves', () => {
  assert.ok(
    copiesDir('migrations'),
    'Dockerfile must COPY migrations/ ./migrations/ — db-migrate.js resolves ../migrations from its own location',
  );
});

test('the migration files the runner applies are all in the copied directory', () => {
  const entries = readdirSync(join(ROOT, 'migrations'));
  assert.ok(
    entries.some(name => name.endsWith('.js')),
    'node-pg-migrate reads .js migrations; the directory must contain at least one',
  );
  assert.ok(
    entries.some(name => name.endsWith('.sql')),
    'the legacy psql path in docs/DEPLOYMENT.md needs the .sql files shipped too',
  );
});

test('every scripts/ path the deployment runbook invokes exists in the repo', () => {
  const referenced = [...deployment.matchAll(/scripts\/([\w.-]+\.(?:js|mjs|cjs))/g)].map(
    match => match[1],
  );
  assert.ok(
    referenced.length > 0,
    'docs/DEPLOYMENT.md must name the script it tells operators to run in a container',
  );
  const shipped = readdirSync(join(ROOT, 'scripts'));
  for (const name of new Set(referenced)) {
    assert.ok(
      shipped.includes(name),
      `docs/DEPLOYMENT.md invokes scripts/${name}, which does not exist in scripts/`,
    );
  }
});
