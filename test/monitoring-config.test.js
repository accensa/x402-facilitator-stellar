import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { runProbes } from '../monitoring/probes.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../monitoring/config.example.json', import.meta.url));

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function assertExactKeys(value, expected, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function assertPositiveInteger(value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`);
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
}

function assertNonNegativeInteger(value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`);
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative integer`);
}

describe('monitoring/config.example.json', () => {
  test('parses as a JSON object with no unexpected top-level keys', () => {
    const config = loadConfig();

    assertExactKeys(config, ['endpoint', 'timeoutMs', 'probe', 'thresholds'], 'root');
  });

  test('HTTP probe settings match the keys probes.mjs reads', () => {
    const config = loadConfig();

    assertNonEmptyString(config.endpoint, 'endpoint');
    assert.doesNotThrow(() => new URL(config.endpoint), 'endpoint must be a URL');
    assertPositiveInteger(config.timeoutMs, 'timeoutMs');

    assertExactKeys(
      config.probe,
      ['healthz', 'readyz', 'supported', 'syntheticPayment', 'signerBalance'],
      'probe',
    );
    for (const name of ['healthz', 'readyz', 'supported']) {
      assert.equal(config.probe[name], true, `probe.${name} must be enabled in the example`);
    }

    assertExactKeys(config.thresholds, ['latencyWarnMs'], 'thresholds');
    assertExactKeys(
      config.thresholds.latencyWarnMs,
      ['healthz', 'readyz', 'supported'],
      'thresholds.latencyWarnMs',
    );
    for (const name of ['healthz', 'readyz', 'supported']) {
      assertPositiveInteger(
        config.thresholds.latencyWarnMs[name],
        `thresholds.latencyWarnMs.${name}`,
      );
    }
  });

  test('synthetic payment settings match the keys probes.mjs reads', () => {
    const synthetic = loadConfig().probe.syntheticPayment;

    assertExactKeys(synthetic, ['enabled', 'command', 'timeoutMs'], 'probe.syntheticPayment');
    assert.equal(
      synthetic.enabled,
      false,
      'probe.syntheticPayment.enabled must stay opt-in in the example',
    );
    assert.equal(
      synthetic.command,
      'node scripts/e2e.mjs',
      'probe.syntheticPayment.command must be the documented synthetic command',
    );
    assertPositiveInteger(synthetic.timeoutMs, 'probe.syntheticPayment.timeoutMs');
  });

  test('signer balance settings match the keys probes.mjs reads', () => {
    const signerBalance = loadConfig().probe.signerBalance;

    assertExactKeys(signerBalance, ['enabled', 'horizonUrl', 'signers'], 'probe.signerBalance');
    assert.equal(
      signerBalance.enabled,
      true,
      'probe.signerBalance.enabled must be on in the example',
    );
    assertNonEmptyString(signerBalance.horizonUrl, 'probe.signerBalance.horizonUrl');
    assert.doesNotThrow(
      () => new URL(signerBalance.horizonUrl),
      'probe.signerBalance.horizonUrl must be a URL',
    );
    assert.ok(Array.isArray(signerBalance.signers), 'probe.signerBalance.signers must be an array');
    assert.ok(signerBalance.signers.length > 0, 'probe.signerBalance.signers must not be empty');

    for (const [index, signer] of signerBalance.signers.entries()) {
      const label = `probe.signerBalance.signers[${index}]`;
      assertExactKeys(
        signer,
        ['address', 'network', 'warnFloorStroops', 'signalFloorStroops'],
        label,
      );
      assertNonEmptyString(signer.address, `${label}.address`);
      assert.equal(signer.network, 'stellar:testnet', `${label}.network`);
      assertNonNegativeInteger(signer.warnFloorStroops, `${label}.warnFloorStroops`);
      assertNonNegativeInteger(signer.signalFloorStroops, `${label}.signalFloorStroops`);
      assert.ok(
        signer.warnFloorStroops > signer.signalFloorStroops,
        `${label}.warnFloorStroops must exceed the signal floor`,
      );
    }
  });

  test('the example config drives every probe branch without a network call', async () => {
    const config = loadConfig();
    const requests = [];
    const commands = [];
    const response = body => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    const fetchImpl = async url => {
      requests.push(url);
      return response(
        url.includes('/accounts/')
          ? { balances: [{ asset_type: 'native', balance: '1000' }] }
          : { ok: true },
      );
    };
    const runCommandImpl = async (command, timeoutMs, env) => {
      commands.push({ command, timeoutMs, env });
      return { ok: true, code: 0, latencyMs: 0 };
    };

    const report = await runProbes({
      config,
      fetchImpl,
      runCommandImpl,
      env: { SYNTHETIC_PAYMENT: 'true' },
      now: () => 0,
    });

    assert.deepEqual(requests, [
      `${config.endpoint}/healthz`,
      `${config.endpoint}/readyz`,
      `${config.endpoint}/supported`,
      `${config.probe.signerBalance.horizonUrl}/accounts/${config.probe.signerBalance.signers[0].address}`,
    ]);
    assert.deepEqual(commands, [
      {
        command: config.probe.syntheticPayment.command,
        timeoutMs: config.probe.syntheticPayment.timeoutMs,
        env: { SYNTHETIC_PAYMENT: 'true' },
      },
    ]);
    assert.deepEqual(Object.keys(report.probes).sort(), [
      'healthz',
      'readyz',
      'signerBalance',
      'supported',
      'syntheticPayment',
    ]);
    assert.deepEqual(report.incidents, []);
    assert.equal(report.status, 'operational');
  });
});
