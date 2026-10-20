/**
 * The published dependency closure (#484), the barrel export map (#486) and
 * the pinned test discovery glob (#489).
 *
 * `package.json` used to ship only `src/sdk` and `src/mcp`, but
 * `src/sdk/cli.js` imports `../catalog/validation.js` and `src/mcp/cli.js`
 * imports `../rpc-retry.js` (which imports `./request-state.js`), so both
 * packaged CLIs died with ERR_MODULE_NOT_FOUND on a fresh install. The
 * closure below is derived from the actual import graph rather than by
 * guesswork: every relative import reachable from either CLI must resolve to
 * a file inside the packaged `files` set.
 *
 * `src/index.js` describes itself as the interface consumers import from, but
 * the package declared no `main` and no `exports`, and `files` omitted the
 * barrel — so the documented import resolved to nothing. The map is pinned
 * here and exercised against the packed tarball by name.
 *
 * Both root `test-*.js` ad-hoc scripts matched Node's test discovery glob, so
 * `npm test` executed them as tests. The glob is pinned to `test/` so a root
 * script can never be collected again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Relative imports (`from './x'`) found in a source file. */
function relativeImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) found.push(match[1]);
  for (const match of text.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    found.push(match[1]);
  }
  return found;
}

/** Transitive relative-import closure of an entry file, as repo-root paths. */
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const spec of relativeImports(path.join(ROOT, current))) {
      let target = path.normalize(path.join(path.dirname(current), spec));
      if (!target.endsWith('.js')) {
        if (fs.existsSync(path.join(ROOT, `${target}.js`))) target = `${target}.js`;
        else if (fs.existsSync(path.join(ROOT, target, 'index.js'))) {
          target = path.join(target, 'index.js');
        } else target = `${target}.js`;
      }
      if (fs.existsSync(path.join(ROOT, target)) && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/** Whether a repo-root file is covered by the `files` allowlist. */
function coveredByFiles(file, files) {
  const normalised = file.replace(/\\/g, '/');
  return files.some(entry => {
    if (normalised === entry) return true;
    if (entry.endsWith('.js')) return normalised === entry;
    return normalised === entry || normalised.startsWith(`${entry}/`);
  });
}

test('package.json:32 — every CLI import resolves inside the packaged file set', () => {
  const entries = [PKG.bin['validate-discovery'], PKG.bin['x402-mcp']].map(p =>
    path.relative(ROOT, path.resolve(ROOT, p)).replace(/\\/g, '/'),
  );
  const closure = new Set();
  for (const entry of entries) {
    for (const file of importClosure(entry)) closure.add(file);
  }
  assert.ok(closure.has('src/catalog/validation.js'), 'sdk CLI closure reaches validation.js');
  assert.ok(closure.has('src/rpc-retry.js'), 'mcp CLI closure reaches rpc-retry.js');
  assert.ok(closure.has('src/request-state.js'), 'rpc-retry closure reaches request-state.js');
  const outside = [...closure].filter(f => !coveredByFiles(f, PKG.files));
  assert.deepEqual(outside, [], `imports outside the packaged file set: ${outside.join(', ')}`);
});

test('package.json:32 — the tarball file list contains the CLI closure', () => {
  const out = execSync('npm pack --dry-run 2>&1', { cwd: ROOT, encoding: 'utf8' });
  for (const needed of [
    'src/sdk/cli.js',
    'src/mcp/cli.js',
    'src/catalog/validation.js',
    'src/rpc-retry.js',
    'src/request-state.js',
    'src/index.js',
  ]) {
    assert.match(out, new RegExp(needed.replace(/[./]/g, '\\$&')), `${needed} must ship`);
  }
});

test('src/index.js:1 — main and exports resolve to the documented barrel', () => {
  assert.equal(PKG.main, './src/index.js');
  assert.ok(PKG.exports, 'exports map must exist');
  assert.deepEqual(PKG.exports['.'], {
    import: './src/index.js',
    default: './src/index.js',
  });
  assert.deepEqual(PKG.exports['./sdk'], {
    import: './src/sdk/index.js',
    default: './src/sdk/index.js',
  });
  assert.deepEqual(PKG.exports['./mcp'], {
    import: './src/mcp/index.js',
    default: './src/mcp/index.js',
  });
  assert.ok(
    PKG.files.some(f => f === 'src/index.js' || f === 'src' || 'src/index.js'.startsWith(`${f}/`)),
    'files must include the barrel',
  );
  for (const target of ['./src/index.js', './src/sdk/index.js', './src/mcp/index.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, target)), `${target} must exist`);
  }
});

test('test-rpc.js:14 — the test script is pinned and root scripts are gone', () => {
  assert.match(PKG.scripts.test, /node --test ["']?test\//, 'test glob must be pinned to test/');
  assert.notEqual(
    PKG.scripts.test.trim(),
    'node --test',
    'a bare `node --test` collects root test-*.js scripts as tests',
  );
  assert.ok(!fs.existsSync(path.join(ROOT, 'test-rpc.js')), 'test-rpc.js must be gone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'test-metrics.js')), 'test-metrics.js must be gone');
});

/**
 * Packs the tarball, extracts it, and runs both CLIs plus the by-name barrel
 * import against the extracted tree — the install-and-execute check from the
 * issue, kept offline by resolving third-party dependencies through a
 * `node_modules` symlink instead of hitting the registry. What this proves is
 * the first-party closure: with the old `files` list the extracted tree was
 * missing `src/catalog/validation.js`, `src/rpc-retry.js` and
 * `src/request-state.js`, and both CLIs died with ERR_MODULE_NOT_FOUND.
 */
test('packed tarball: both CLIs run and the barrel imports by name', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-pack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const packOut = execSync(`npm pack --pack-destination ${JSON.stringify(dir)}`, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const tarballName = packOut.trim().split('\n').pop();
  const tarball = path.join(dir, tarballName);
  execSync(`tar -xzf ${JSON.stringify(tarball)} -C ${JSON.stringify(dir)}`);
  const extracted = path.join(dir, 'package');
  // Offline third-party resolution: the tarball ships only first-party files,
  // exactly like a registry install; link the workspace modules so bare
  // imports (`@x402/*`, `fastify`, …) resolve without network access.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(extracted, 'node_modules'), 'dir');

  const sdkCli = path.join(extracted, 'src/sdk/cli.js');
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ routeTemplate: '/api/:id', pricing: { amount: '1' } }));
  const out = execFileSync(process.execPath, [sdkCli, good], { encoding: 'utf8' });
  assert.match(out, /Validation passed/);

  const child = spawn(process.execPath, [path.join(extracted, 'src/mcp/cli.js')], {
    env: { ...process.env, AGENT_PAYER_SECRET_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const readFrame = () =>
    new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('timed out waiting for x402-mcp')), 15000);
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const line = buffer.split('\n')[0];
        if (line && line.trim()) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line));
          } catch (err) {
            reject(err);
          }
        }
      });
      child.on('error', reject);
    });
  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    );
    const init = await readFrame();
    assert.equal(init.result.serverInfo.name, 'x402-facilitator-stellar-mcp');
  } finally {
    child.kill();
  }

  const consumer = path.join(dir, 'consumer');
  const scoped = path.join(consumer, 'node_modules', '@accensa', 'x402-facilitator-stellar');
  fs.mkdirSync(path.dirname(scoped), { recursive: true });
  fs.symlinkSync(extracted, scoped, 'dir');
  fs.writeFileSync(
    path.join(consumer, 'check.mjs'),
    `import * as pkg from '@accensa/x402-facilitator-stellar';
     import * as sdk from '@accensa/x402-facilitator-stellar/sdk';
     import * as mcp from '@accensa/x402-facilitator-stellar/mcp';
     import assert from 'node:assert/strict';
     for (const name of ['createApp', 'buildFacilitator', 'createMetrics',
       'buildSettlementStore', 'MemorySettlementStore', 'PostgresSettlementStore',
       'McpServer', 'createRequestLog', 'parseLogLevel', 'withErrorHandling']) {
       assert.ok(pkg[name], name);
     }
     assert.equal(typeof pkg.createApp, 'function');
     assert.equal(typeof pkg.buildFacilitator, 'function');
     assert.equal(typeof sdk.toStroops, 'function');
     assert.equal(typeof sdk.createStellarDiscoveryResource, 'function');
     assert.equal(typeof mcp.McpServer, 'function');
     console.log('barrel-by-name ok');`,
  );
  const checkOut = execFileSync(process.execPath, [path.join(consumer, 'check.mjs')], {
    cwd: consumer,
    encoding: 'utf8',
  });
  assert.match(checkOut, /barrel-by-name ok/);
});
