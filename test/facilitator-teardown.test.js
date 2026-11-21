/**
 * buildFacilitator().stop() ends every key-rotation interval it started (#672).
 *
 * buildFacilitator calls keyManager.start() per network, and start() installs a
 * setInterval (src/key-manager.js). Nothing stopped them: shutdown closed the
 * app, the tracer and the metrics listener while the intervals lived on, and a
 * test that built a facilitator left one running until the process happened to
 * exit because start() unrefs its timer.
 *
 * These tests stub KeyManager's timer installation so each build records the
 * handles it created. Those handles are real `node:timers` intervals, and the
 * production KeyManager.stop() clears them through the same clearInterval that
 * started them — so the assertion is about a cleared interval, not a mock that
 * was called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setInterval as nodeSetInterval } from 'node:timers';
import { Keypair } from '@stellar/stellar-sdk';
import { KeyManager } from '../src/key-manager.js';
import { buildFacilitator } from '../src/facilitator.js';
import { resolveConfig } from '../src/config.js';

const TICK_MS = 10;
const OBSERVE_MS = 50;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Two networks, so "every key manager" is more than one, and a poll interval
 * so start() would install a timer for each.
 */
function twoNetworkConfig({ pollIntervalMs = TICK_MS } = {}) {
  return resolveConfig({
    FACILITATOR_SECRET: Keypair.random().secret(),
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: Keypair.random().secret(),
    STELLAR_RPC_URL_PUBNET: 'https://mainnet.rpc.example.com',
    KEY_MANAGER_URL: 'https://keys.example.com/signers',
    KEY_MANAGER_POLL_INTERVAL_MS: String(pollIntervalMs),
  });
}

test('stop() clears every key-manager interval a build started (#672)', async t => {
  const started = [];

  // Stub the timer installation, not the teardown: KeyManager.stop() under
  // test is the real one, clearing the real handle this installs.
  t.mock.method(KeyManager.prototype, 'start', function () {
    const state = { ticks: 0 };
    const handle = nodeSetInterval(() => {
      state.ticks += 1;
    }, TICK_MS);
    handle.unref();
    this.timer = handle;
    started.push({ manager: this, handle, state });
  });

  const built = buildFacilitator(twoNetworkConfig());
  try {
    const networks = Object.keys(built.keyManagers);
    assert.equal(networks.length, 2, 'two networks must yield two key managers');
    assert.equal(
      started.length,
      networks.length,
      'every manager must have installed exactly one handle',
    );
    for (const network of networks) {
      assert.ok(
        started.some(({ manager }) => manager === built.keyManagers[network]),
        `the handle for ${network} must belong to the manager the build returned`,
      );
    }

    // The intervals are live before the stop — otherwise "cleared" is vacuous.
    await sleep(OBSERVE_MS);
    assert.ok(
      started.every(({ state }) => state.ticks > 0),
      `expected every interval to fire before stop(), got ${started.map(({ state }) => state.ticks)}`,
    );

    built.stop();

    for (const { manager } of started) {
      assert.equal(manager.timer, null, 'stop() must clear every manager it started');
    }
    const ticksAfterStop = started.map(({ state }) => state.ticks);
    await sleep(OBSERVE_MS);
    assert.deepEqual(
      started.map(({ state }) => state.ticks),
      ticksAfterStop,
      'a cleared interval must not fire again',
    );
  } finally {
    built.stop();
  }
});

test('stop() is safe to call twice and covers a manager that never started (#672)', () => {
  // pollIntervalMs 0 means start() installed no timer: a manager that never
  // started must not make the teardown throw.
  const built = buildFacilitator(twoNetworkConfig({ pollIntervalMs: 0 }));
  for (const manager of Object.values(built.keyManagers)) {
    assert.equal(manager.timer, null);
  }

  assert.doesNotThrow(() => built.stop());
  assert.doesNotThrow(() => built.stop());
  for (const manager of Object.values(built.keyManagers)) {
    assert.equal(manager.timer, null);
  }
});
