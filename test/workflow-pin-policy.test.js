import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');

/**
 * Extracts all `uses:` values from a parsed workflow object.
 * In GitHub Actions, `uses:` can appear on a reusable workflow job call
 * or on individual job steps.
 *
 * @param {unknown} doc - Parsed YAML workflow
 * @returns {string[]} Array of `uses:` target strings
 */
function extractUses(doc) {
  const usesList = [];
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') {
    return usesList;
  }

  for (const job of Object.values(doc.jobs)) {
    if (!job || typeof job !== 'object') continue;

    // Reusable workflow invocation at job level (e.g. `uses: ./.github/workflows/...`)
    if (typeof job.uses === 'string') {
      usesList.push(job.uses);
    }

    // Step-level action invocations
    if (Array.isArray(job.steps)) {
      for (const step of job.steps) {
        if (step && typeof step.uses === 'string') {
          usesList.push(step.uses);
        }
      }
    }
  }

  return usesList;
}

test('workflow action references policy (#752)', async t => {
  const workflowFiles = readdirSync(WORKFLOWS_DIR).filter(
    name => name.endsWith('.yml') || name.endsWith('.yaml'),
  );

  assert.ok(workflowFiles.length > 0, 'no workflow files found in .github/workflows');

  for (const file of workflowFiles) {
    await t.test(`${file} pins all remote action references to commit SHAs`, () => {
      const raw = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      const doc = load(raw);
      const usesList = extractUses(doc);

      for (const uses of usesList) {
        // 1. Local actions/workflows (e.g. `./.github/workflows/...`):
        // Governed by the repository itself and already version-controlled; skip.
        if (uses.startsWith('./')) {
          continue;
        }

        // 2. Docker container actions (`docker://...`):
        // Docker actions reference container images rather than Git repositories.
        // To prevent supply-chain poisoning from mutable image tags, docker actions
        // must be pinned by an immutable sha256 digest (@sha256:64-hex).
        if (uses.startsWith('docker://')) {
          assert.match(
            uses,
            /^docker:\/\/.+@sha256:[a-f0-9]{64}$/,
            `${file}: docker action "${uses}" must be pinned by sha256 digest`,
          );
          continue;
        }

        // 3. Remote actions:
        // Must be pinned to a full 40-character commit SHA to prevent mutable tag hijacking.
        assert.match(
          uses,
          /@[a-f0-9]{40}\b/,
          `${file}: action "${uses}" is not pinned to a 40-character commit SHA`,
        );
      }
    });
  }
});
