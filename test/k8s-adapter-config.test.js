/**
 * Keeps the Prometheus Adapter rule scoped to this deployment (issue #738).
 *
 * The external rule used to be a bare `seriesQuery: 'active_verifications'`
 * with `metricsQuery: 'sum(active_verifications)'`, which matches any series
 * of that name anywhere in the cluster and hands the HPA one cluster-wide
 * total. With two facilitator instances in different namespaces, each HPA saw
 * the sum of both and scaled on traffic it does not serve.
 *
 * This test parses the values file and asserts the query carries an explicit
 * namespace association and service label matcher, plus the adapter's
 * `<<.LabelMatchers>>` template so the HPA can narrow further.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALUES_PATH = join(ROOT, 'deploy/kubernetes/prometheus-adapter-values.yaml');

/** The parsed values file. */
function loadValues() {
  return loadYaml(readFileSync(VALUES_PATH, 'utf8'));
}

/** The single external rule that exposes active_verifications. */
function activeVerificationsRule() {
  const values = loadValues();
  const rules = values?.rules?.external ?? [];
  const rule = rules.find(r => r?.name?.as === 'active_verifications');

  assert.ok(rule, 'rules.external must define the active_verifications metric');
  return rule;
}

test('the values file is valid YAML with the external rule enabled', () => {
  const values = loadValues();

  assert.equal(values?.rules?.default, false, 'default rules must stay disabled');
  assert.ok(Array.isArray(values?.rules?.external), 'rules.external must be a list');
});

test('seriesQuery is scoped by namespace and service labels', () => {
  const { seriesQuery } = activeVerificationsRule();

  assert.equal(typeof seriesQuery, 'string', 'seriesQuery must be a string');
  assert.match(
    seriesQuery,
    /^active_verifications\{/,
    'seriesQuery must select the metric with a matcher set',
  );
  assert.match(
    seriesQuery,
    /namespace!=""/,
    'seriesQuery must require the Kubernetes namespace label so samples stay attributable',
  );
  assert.match(
    seriesQuery,
    /service="x402-facilitator"/,
    'seriesQuery must constrain the service label to this deployment',
  );
});

test('metricsQuery is scoped and preserves per-namespace series', () => {
  const { metricsQuery } = activeVerificationsRule();

  assert.equal(typeof metricsQuery, 'string', 'metricsQuery must be a string');
  assert.match(
    metricsQuery,
    /<<\.Series>>/,
    'metricsQuery must use the adapter <<.Series>> template',
  );
  assert.match(
    metricsQuery,
    /<<\.LabelMatchers>>/,
    'metricsQuery must keep <<.LabelMatchers>> so HPA selectors narrow the query',
  );
  assert.match(metricsQuery, /namespace!=""/, 'metricsQuery must require the namespace label');
  assert.match(
    metricsQuery,
    /service="x402-facilitator"/,
    'metricsQuery must filter to this deployment by service label',
  );
  assert.match(
    metricsQuery,
    /by \(namespace\)/,
    'metricsQuery must aggregate per namespace rather than into one cluster-wide total',
  );
});

test('the query cannot fall back to the unscoped cluster-wide sum', () => {
  const rule = activeVerificationsRule();

  assert.doesNotMatch(
    rule.seriesQuery,
    /^active_verifications$/,
    'seriesQuery must not be the bare metric name',
  );
  assert.doesNotMatch(
    rule.metricsQuery,
    /sum\(active_verifications\)/,
    'metricsQuery must not sum the bare metric across every namespace',
  );
});
