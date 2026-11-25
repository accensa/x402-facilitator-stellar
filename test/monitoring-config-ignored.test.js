import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('monitoring/config.json is ignored by git', () => {
  const result = spawnSync('git', ['check-ignore', 'monitoring/config.json']);
  assert.equal(result.status, 0, 'git check-ignore monitoring/config.json should exit with code 0');
});

test('monitoring/config.example.json is tracked and not ignored by git', () => {
  const result = spawnSync('git', ['check-ignore', 'monitoring/config.example.json']);
  assert.notEqual(result.status, 0, 'monitoring/config.example.json should not be ignored');
});
