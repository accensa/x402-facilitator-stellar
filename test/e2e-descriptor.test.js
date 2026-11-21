import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DESCRIPTOR = join(ROOT, 'e2e/accensa-proxy/test.config.json');
const LAUNCHER = join(ROOT, 'e2e/accensa-proxy/run.sh');

function loadDescriptor() {
  return JSON.parse(readFileSync(DESCRIPTOR, 'utf8'));
}

function launcherEntry() {
  const launcher = readFileSync(LAUNCHER, 'utf8');
  const match = launcher.match(/^\s*([^\s#]+)\s+(\S+\.(?:js|mjs|ts|mts))\s*&?\s*$/m);
  assert.ok(match, 'run.sh must start the facilitator with an explicit entry point');
  return { runner: match[1], entry: match[2] };
}

describe('e2e proxy descriptor', () => {
  test('is valid JSON with the harness contract fields intact', () => {
    const config = loadDescriptor();

    assert.deepEqual(
      Object.keys(config).sort(),
      [
        'endpoints',
        'environment',
        'language',
        'name',
        'protocolFamilies',
        'schemes',
        'type',
        'x402Versions',
      ],
      'unexpected top-level keys in the descriptor',
    );
    assert.equal(config.name, 'accensa/stellar');
    assert.equal(config.type, 'facilitator');
    assert.deepEqual(config.protocolFamilies, ['stellar']);
    assert.deepEqual(config.x402Versions, [2]);
    assert.deepEqual(config.schemes, ['exact']);
    assert.deepEqual(config.endpoints, [{ path: '/healthz', health: true }]);
    assert.deepEqual(Object.keys(config.environment).sort(), ['optional', 'required']);
    assert.deepEqual(config.environment.required, ['PORT', 'FACILITATOR_SECRET']);
    assert.deepEqual(config.environment.optional, ['STELLAR_RPC_URL', 'ACCENSA_FACILITATOR_DIR']);
  });

  test('declares the language of the process run.sh actually starts', () => {
    const { language } = loadDescriptor();
    const { runner, entry } = launcherEntry();

    assert.equal(runner, 'node', 'the launcher must run the service with plain Node.js');
    assert.match(entry, /\.js$/, 'the entry point must be a JavaScript file');
    assert.ok(existsSync(join(ROOT, entry)), `${entry} does not exist`);
    assert.equal(language, 'javascript', 'the descriptor must not claim TypeScript tooling');
  });
});
