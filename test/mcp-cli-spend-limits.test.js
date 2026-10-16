import { test } from 'node:test';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

test('malformed MAX_FEE_PER_CALL_STROOPS abc exits non-zero naming variable', () => {
  let stderr = '';
  try {
    execSync('MAX_FEE_PER_CALL_STROOPS=abc node src/mcp/cli.js', {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  assert.ok(stderr.includes('MAX_FEE_PER_CALL_STROOPS'));
  assert.ok(!stderr.includes('Stack'));
});

test('malformed MAX_FEE_PER_CALL_STROOPS -5 exits non-zero naming variable', () => {
  let stderr = '';
  try {
    execSync('MAX_FEE_PER_CALL_STROOPS=-5 node src/mcp/cli.js', {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  assert.ok(stderr.includes('MAX_FEE_PER_CALL_STROOPS'));
  assert.ok(!stderr.includes('Stack'));
});

test('malformed MAX_FEE_PER_CALL_STROOPS 1,000 exits non-zero naming variable', () => {
  let stderr = '';
  try {
    execSync('MAX_FEE_PER_CALL_STROOPS=1,000 node src/mcp/cli.js', {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  assert.ok(stderr.includes('MAX_FEE_PER_CALL_STROOPS'));
  assert.ok(!stderr.includes('Stack'));
});

test('malformed MAX_SESSION_SPEND_STROOPS abc exits non-zero naming variable', () => {
  let stderr = '';
  try {
    execSync('MAX_SESSION_SPEND_STROOPS=abc node src/mcp/cli.js', {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  assert.ok(stderr.includes('MAX_SESSION_SPEND_STROOPS'));
  assert.ok(!stderr.includes('Stack'));
});

test('malformed MAX_SESSION_SPEND_STROOPS -5 exits non-zero naming variable', () => {
  let stderr = '';
  try {
    execSync('MAX_SESSION_SPEND_STROOPS=-5 node src/mcp/cli.js', {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  assert.ok(stderr.includes('MAX_SESSION_SPEND_STROOPS'));
  assert.ok(!stderr.includes('Stack'));
});

test('0 is accepted as a legitimate MAX_FEE_PER_CALL_STROOPS limit', () => {
  const result = execSync('MAX_FEE_PER_CALL_STROOPS=0 node src/mcp/cli.js', {
    env: { ...process.env },
    stdio: 'pipe',
  });
  assert.ok(Buffer.isBuffer(result));
});

test('unset MAX_FEE_PER_CALL_STROOPS allows CLI to start', () => {
  const result = execSync('node src/mcp/cli.js', {
    env: { ...process.env, MAX_FEE_PER_CALL_STROOPS: undefined },
    stdio: 'pipe',
  });
  assert.ok(Buffer.isBuffer(result));
});

test('unset MAX_SESSION_SPEND_STROOPS allows CLI to start', () => {
  const result = execSync('node src/mcp/cli.js', {
    env: { ...process.env, MAX_SESSION_SPEND_STROOPS: undefined },
    stdio: 'pipe',
  });
  assert.ok(Buffer.isBuffer(result));
});
