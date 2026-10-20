/**
 * Vault boot wiring regression cases (#561) — no network, no Vault server.
 *
 * Before this fix, `createVaultManagedDatabase` forwarded its `nodeVault`
 * parameter unexamined: the only production caller (src/server.js:98-105)
 * passes vault/databaseUrl/warn/log and nothing else, so a boot with
 * `VAULT_ADDR` configured evaluated `nodeVault(...)` with undefined and threw
 * `nodeVault is not a function` — *above* the degrade `try`, so it aborted
 * boot instead of taking the documented no-database-pool path. Every pre-
 * existing test injected a fake, which is why the gap was invisible.
 *
 * These two cases pin the fixed wiring: the declared dependency resolves for
 * real (a boot with an unreachable Vault degrades instead of a TypeError),
 * and the injectable override still reaches the client — and throws from it
 * degrade, not abort.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createVaultManagedDatabase } from '../src/vault/database.js';

/**
 * Runs `run` with console.warn/info absorbed so a degrade-path log or a
 * dependency's stderr does not pollute the TAP output.
 */
async function withQuietConsole(run) {
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = () => {};
  console.info = () => {};
  try {
    await run();
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
}

/** Port 1 is unassigned and closed on localhost: an instant connection error. */
const UNREACHABLE_ADDRESS = 'http://127.0.0.1:1';

/** Minimal Vault config, what src/config.js resolves from VAULT_* env. */
const VAULT_CONFIG = {
  address: UNREACHABLE_ADDRESS,
  namespace: undefined,
  dbMount: 'database',
  dbRole: 'facilitator',
  pollIntervalMs: 0,
};

describe('Vault boot wiring with no injected factory (#561)', () => {
  test('a boot with VAULT_ADDR configured degrades instead of throwing TypeError', async () => {
    const warnings = [];
    await withQuietConsole(async () => {
      const started = await createVaultManagedDatabase({
        vault: VAULT_CONFIG,
        databaseUrl: 'postgres://127.0.0.1:1/x402',
        // No `nodeVault`, no `Pool` — exactly what src/server.js passes.
        warn: msg => warnings.push(msg),
        log: () => {},
        bootTimeoutMs: 1_000,
      });

      assert.strictEqual(started.pool, null);
      assert.strictEqual(started.creds, null);
      await started.stop();
    });

    // The TypeError from the unfixed wiring (raised before the degrade
    // handler) would have escaped this call entirely. Instead the documented
    // degrade path ran and announced itself. (The credential manager may warn
    // separately about the login failure — the operator-facing signal here is
    // the degrade line.)
    assert.ok(warnings.length >= 1, 'the degrade path warns');
    assert.strictEqual(
      warnings.filter(w => w.includes('starting without a database-backed pool')).length,
      1,
      'exactly one degrade announcement',
    );
    assert.ok(
      !warnings.some(w => w.includes('nodeVault is not a function')),
      'the dead wiring failure must not be the reported error',
    );
  });

  test('an injected throwing factory degrades the same way, not aborts boot', async () => {
    const warnings = [];
    await withQuietConsole(async () => {
      const started = await createVaultManagedDatabase({
        vault: VAULT_CONFIG,
        databaseUrl: 'postgres://127.0.0.1:1/x402',
        nodeVault: () => {
          throw new Error('vault wiring exploded');
        },
        warn: msg => warnings.push(msg),
        log: () => {},
        bootTimeoutMs: 1_000,
      });

      assert.strictEqual(started.pool, null);
      assert.strictEqual(started.creds, null);
      await started.stop();
    });

    assert.ok(warnings.length >= 1, 'the degrade path warns');
    assert.strictEqual(
      warnings.filter(w => w.includes('starting without a database-backed pool')).length,
      1,
      'exactly one degrade announcement',
    );
    assert.ok(warnings.some(w => w.includes('vault wiring exploded')));
  });
});
