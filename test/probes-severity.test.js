import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('probe severity mappings are explicitly defined for all HTTP probes', async () => {
  const probesFilePath = resolve(process.cwd(), 'monitoring/probes.mjs');
  const content = await readFile(probesFilePath, 'utf8');

  // Extract PROBE_SEVERITY and HTTP_PROBES using regex matching
  const severityMatch = content.match(/const\s+PROBE_SEVERITY\s*=\s*({[^}]+});/);
  assert.ok(severityMatch, 'PROBE_SEVERITY should be defined in monitoring/probes.mjs');
  const probeSeverity = Function(`"use strict"; return (${severityMatch[1]});`)();

  const httpProbesMatch = content.match(/const\s+HTTP_PROBES\s*=\s*(\[[^\]]+\]);/);
  assert.ok(httpProbesMatch, 'HTTP_PROBES should be defined in monitoring/probes.mjs');
  const httpProbes = Function(`"use strict"; return (${httpProbesMatch[1]});`)();

  assert.equal(probeSeverity.healthz, 'down', 'healthz probe must map to down severity');
  assert.equal(probeSeverity.readyz, 'warn', 'readyz probe must map to warn severity');
  assert.equal(probeSeverity.supported, 'warn', 'supported probe must map to warn severity');

  for (const probe of httpProbes) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(probeSeverity, probe),
      `Probe "${probe}" in HTTP_PROBES must have an explicit mapping in PROBE_SEVERITY`,
    );
    assert.ok(
      probeSeverity[probe] !== undefined,
      `Probe "${probe}" severity mapping must not be undefined`,
    );
  }
});
