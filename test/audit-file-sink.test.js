/**
 * AUDIT_LOG_FILE sink (#587).
 *
 * The operator knob must actually append audit records to a file while stdout
 * keeps receiving the same line, an unwritable path must not kill the process
 * or silence stdout, and close() must flush a record written immediately
 * before shutdown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuditLogger } from '../src/audit.js';
import { serve, testConfig, stubFacilitator, stubCatalog, VALID_BODY } from './helpers/app.js';

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'audit-sink-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Captures process.stdout.write calls for the duration of `fn`. */
async function captureStdout(fn) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return lines;
}

test('each record is appended to AUDIT_LOG_FILE and stdout with identical redaction', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'audit.jsonl');
  const audit = createAuditLogger({ file });

  const lines = await captureStdout(async () => {
    audit('settlement', {
      actor: 'key_1',
      transaction: 'tx-1',
      signature: 'SECRET_SIGNATURE',
      network: 'stellar:testnet',
    });
    await audit.close();
  });

  const written = (await fsp.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(written.length, 1);
  assert.equal(lines.length, 1);
  // The copies are byte-identical: channel marker and redaction included.
  assert.equal(written[0], lines[0].trimEnd());

  const record = JSON.parse(written[0]);
  assert.equal(record.channel, 'audit');
  assert.equal(record.event, 'settlement');
  assert.equal(record.signature, '[redacted]');
  assert.equal(record.transaction, 'tx-1');
});

test('an unwritable path is reported once and stdout keeps receiving audit records', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'missing', 'audit.jsonl');
  const errors = [];
  const audit = createAuditLogger({ file, onError: message => errors.push(message) });

  const lines = await captureStdout(async () => {
    // Let the stream's asynchronous ENOENT reach the error listener.
    await new Promise(resolve => setTimeout(resolve, 50));
    audit('auth_failure', { actor: 'ip:abc', reason: 'bad_key' });
    audit('settlement', { actor: 'ip:abc', transaction: 'tx-2' });
    await audit.close();
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /AUDIT_LOG_FILE/);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event, 'auth_failure');
  assert.equal(JSON.parse(lines[1]).event, 'settlement');
});

test('close() flushes a record written immediately before shutdown', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'audit.jsonl');
  const audit = createAuditLogger({ file });

  await captureStdout(async () => {
    audit('settlement', { actor: 'key_1', transaction: 'tx-flush' });
    await audit.close();
  });

  const text = await fsp.readFile(file, 'utf8');
  assert.equal(text.endsWith('\n'), true, 'the file must end with a complete line');
  assert.equal(JSON.parse(text.trim()).transaction, 'tx-flush');
});

test('createApp passes config.auditLogFile to the audit logger', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'app-audit.jsonl');
  let instance;
  await captureStdout(async () => {
    instance = await serve({
      config: { ...testConfig(), auditLogFile: file },
      facilitator: stubFacilitator(),
      catalog: stubCatalog(),
    });
    const res = await instance.post('/settle', VALID_BODY);
    assert.equal(res.status, 200);
    await instance.app.auditLogger.close();
  });

  try {
    const records = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(
      records.some(record => record.event === 'settlement'),
      true,
    );
  } finally {
    await instance.close();
  }
});
