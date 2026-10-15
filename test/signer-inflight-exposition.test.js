/**
 * The concatenated /metrics exposition declares each series once (#558).
 *
 * `GET /metrics` sends `metrics.render() + signerMetrics.toPrometheusText()`
 * (src/app.js:376-378). Both halves used to define `x402_signer_inflight` —
 * the registry gauge fed by `setSignerInflight` from the request path, and a
 * second HELP/TYPE/sample block in `toPrometheusText` fed by
 * `incrementInflight`/`decrementInflight`, which have no callers in src/ at
 * all. One Prometheus text page may name a series once.
 *
 * This file parses the combined text exactly like a scraper would and pins:
 *   - every metric name appears once across the concatenated page;
 *   - the registry gauge keeps the live in-flight signal (non-zero after a
 *     `setSignerInflight` call), so docs/OPERATIONS.md's sequence-contention
 *     alert still has its series;
 *   - `toPrometheusText` still owns `x402_signer_selected_total`, with every
 *     label value escaped.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics } from '../src/metrics.js';
import { signerMetrics } from '../src/metrics.js';

function parseExposition(text) {
  const helpNames = [];
  const typeNames = [];
  const samples = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('# HELP ')) helpNames.push(line.split(' ')[2]);
    else if (line.startsWith('# TYPE ')) typeNames.push(line.split(' ')[2]);
    else if (line && !line.startsWith('#')) samples.push(line);
  }
  return { helpNames, typeNames, samples };
}

describe('signer inflight has a single exposition owner (#558)', () => {
  test('the combined /metrics page declares every series name once', () => {
    const metrics = createMetrics();
    const combined = metrics.render() + signerMetrics.toPrometheusText();
    const { helpNames, typeNames } = parseExposition(combined);

    for (const [kinds, list] of [
      ['# HELP blocks', helpNames],
      ['# TYPE blocks', typeNames],
    ]) {
      const seen = new Set();
      for (const name of list) {
        assert.ok(
          !seen.has(name),
          `series ${name} is declared twice in the ${kinds} of the combined page`,
        );
        seen.add(name);
      }
    }
  });

  test('the live in-flight reading survives on the registry gauge', () => {
    const metrics = createMetrics();
    metrics.setSignerInflight({ network: 'stellar:testnet', signer: 'SABC', value: 2 });
    const { samples } = parseExposition(metrics.render() + signerMetrics.toPrometheusText());

    const inflight = samples.filter(line => line.startsWith('x402_signer_inflight{'));
    assert.strictEqual(inflight.length, 1);
    assert.match(inflight[0], /x402_signer_inflight\{network="stellar:testnet",signer="SABC"\} 2$/);
  });

  test('x402_signer_selected_total remains scrapeable from toPrometheusText', () => {
    signerMetrics.recordSelection('stellar:testnet', 'SDEF');

    const metrics = createMetrics();
    const { samples } = parseExposition(metrics.render() + signerMetrics.toPrometheusText());

    const selected = samples.filter(line => line.startsWith('x402_signer_selected_total{'));
    assert.ok(selected.length >= 1);
    assert.ok(selected.some(line => line.includes('network="stellar:testnet",signer="SDEF"')));
  });

  test('toPrometheusText escapes every label value', () => {
    signerMetrics.recordSelection('before\\after', 'a"quoted"signer');

    const { samples } = parseExposition(signerMetrics.toPrometheusText());
    const ours = samples.find(line => line.includes('quoted'));

    assert.ok(ours, 'the quoted selection must be present in the exposition');
    assert.ok(!ours.includes('a"quoted"signer'), 'raw quote must not survive');
    // Prometheus escaping doubles every backslash and escapes every quote:
    // `before\after` renders with two, `a"quoted"signer` with \\".
    assert.match(ours, /network="before\\\\after"/);
    assert.match(ours, /signer="a\\"quoted\\"signer"/);
  });
});
