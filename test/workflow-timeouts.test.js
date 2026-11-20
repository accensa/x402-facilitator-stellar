/**
 * No CI job may run unbounded (#731).
 *
 * GitHub cancels a job that sets no `timeout-minutes` only after its default
 * six hours, so one hung benchmark, probe or install holds a runner for the
 * whole afternoon. Bounding every runner job makes that a minutes-long
 * failure instead. This parses the workflow files rather than grepping them,
 * so a timeout nested under the wrong key, or commented out, does not pass.
 *
 * Reusable-workflow callers are the one exception: GitHub rejects the key on a
 * `jobs.<id>.uses` job. Their bound is asserted on the jobs inside the called
 * workflow instead, so the effective run is still bounded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const WORKFLOW_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

/** Every workflow file, sorted so failures are reported deterministically. */
const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

function loadWorkflow(file) {
  const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
  const workflow = loadYaml(source, { filename: file });
  assert.ok(
    workflow && typeof workflow === 'object',
    `${file} did not parse to a workflow mapping`,
  );
  assert.ok(
    workflow.jobs && typeof workflow.jobs === 'object',
    `${file} has no jobs mapping to validate`,
  );
  return workflow;
}

/**
 * The workflow file a local reusable-workflow reference points at, or null for
 * a workflow in another repository. Accepts both `./` and the `$/` spelling and
 * ignores an optional `@ref`.
 */
function localReusableWorkflow(uses) {
  if (typeof uses !== 'string') return null;
  const match = /^(?:\.|\$)\/\.github\/workflows\/([^@]+?)(?:@.*)?$/.exec(uses);
  return match ? match[1] : null;
}

function boundedTimeout(job) {
  const timeout = job?.['timeout-minutes'];
  return Number.isInteger(timeout) && timeout > 0;
}

test('every runner job declares a non-zero timeout-minutes', () => {
  const failures = [];

  for (const file of workflowFiles) {
    const workflow = loadWorkflow(file);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (job?.uses) continue; // a reusable-workflow caller: see the next test
      if (!boundedTimeout(job)) {
        failures.push(
          `${file}:${id} has timeout-minutes=${JSON.stringify(job?.['timeout-minutes'])}`,
        );
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    'every job that runs on a runner must set a non-zero timeout-minutes — ' +
      `without it GitHub allows the 360-minute default:\n${failures.join('\n')}`,
  );
});

test("a reusable-workflow caller's job is bounded inside the called workflow", () => {
  const failures = [];

  for (const file of workflowFiles) {
    const workflow = loadWorkflow(file);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (!job?.uses) continue;
      const calledFile = localReusableWorkflow(job.uses);
      if (!calledFile) continue; // another repository: nothing local to inspect

      if (!workflowFiles.includes(calledFile)) {
        failures.push(`${file}:${id} calls ${job.uses}, which is not a workflow in this repo`);
        continue;
      }

      const called = loadWorkflow(calledFile);
      const calledJobs = Object.entries(called.jobs);
      if (calledJobs.length === 0) {
        failures.push(`${file}:${id} calls ${calledFile}, which declares no jobs`);
        continue;
      }

      for (const [calledId, calledJob] of calledJobs) {
        // A nested reusable caller is validated when that workflow is visited.
        if (calledJob?.uses) continue;
        if (!boundedTimeout(calledJob)) {
          failures.push(
            `${file}:${id} -> ${calledFile}:${calledId} has ` +
              `timeout-minutes=${JSON.stringify(calledJob?.['timeout-minutes'])}`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    'GitHub does not allow timeout-minutes on a reusable-workflow caller, so the ' +
      `called workflow's jobs must set their own bound:\n${failures.join('\n')}`,
  );
});

test('the bench job is bounded so a hung benchmark cannot hold a runner', () => {
  const workflow = loadWorkflow('bench.yml');
  assert.equal(
    workflow.jobs.bench['timeout-minutes'],
    20,
    'bench.yml must bound the bench job (issue #731)',
  );
});
