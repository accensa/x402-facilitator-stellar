/**
 * One series, one definition (#558).
 *
 * GET /metrics (src/app.js:376) concatenates `createMetrics().render()` and
 * `signerMetrics.toPrometheusText()`. `SignerMetrics` used to push its own
 * HELP/TYPE pair and samples for `x402_signer_inflight`, so one exposition
 * named the series twice with different values — the sequence-contention
 * signal the OPERATIONS alert reads. These tests pin the single-owner split:
 * the registry gauge owns `x402_signer_inflight`, `SignerMetrics` owns only
 * `x402_signer_selected_total`, and every label value the class writes goes
 * through `escapeLabelValue`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, signerMetrics } from '../src/metrics.js';

/** Parses a Prometheus text exposition into a metric-name -> samples map. */
function parseExposition(text) {
  const samples = new Map();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const space = line.indexOf(' ');
    const labelsStart = line.indexOf('{');
    const name = labelsStart === -1 ? line.slice(0, space) : line.slice(0, labelsStart);
    if (!samples.has(name)) samples.set(name, []);
    samples.get(name).push(parseFloat(line.slice(space + 1).trim()));
  }
  return samples;
}

describe('the concatenated /metrics exposition', () => {
  test('declares x402_signer_inflight once, even after both renderers run', () => {
    const metrics = createMetrics();
    const combined = metrics.render() + signerMetrics.toPrometheusText();

    const typeLines = combined
      .split('\n')
      .filter(line => line.startsWith('# TYPE x402_signer_inflight'));
    const helpLines = combined
      .split('\n')
      .filter(line => line.startsWith('# HELP x402_signer_inflight'));
    assert.equal(typeLines.length, 1, 'one # TYPE per series: ' + combined);
    assert.equal(helpLines.length, 1, 'one # HELP per series');
  });

  test('a non-zero in-flight reading and the selection counter survive the concatenation', () => {
    const metrics = createMetrics();
    metrics.setSignerInflight({ network: 'stellar:testnet', signer: 'GALPHA', value: 2 });
    signerMetrics.recordSelection('stellar:testnet', 'GALPHA');

    const combined = metrics.render() + signerMetrics.toPrometheusText();
    const parsed = parseExposition(combined);

    assert.deepEqual(
      parsed.get('x402_signer_inflight').filter(v => v > 0),
      [2],
      'the OPERATIONS alert series keeps its non-zero reading',
    );
    assert.ok(
      parsed.has('x402_signer_selected_total'),
      'the selection counter is still scrapeable',
    );
  });

  test('SignerMetrics label values go through escapeLabelValue', () => {
    // Records a selection whose network name carries characters the
    // exposition format demands be escaped.
    signerMetrics.recordSelection('network"quoted', 'signer\\back');
    const text = signerMetrics.toPrometheusText();

    assert.ok(text.includes('network="network\\"quoted"'), `the quote must be escaped: ${text}`);
    assert.ok(text.includes('signer="signer\\\\back"'), `the backslash must be escaped: ${text}`);
    // It still parses back: the sample line stays readable.
    const sample = text
      .split('\n')
      .find(line => line.startsWith('x402_signer_selected_total{') && line.includes('quoted'));
    assert.ok(sample, 'the sample is present');
  });
});
