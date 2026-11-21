import test from 'node:test';
import assert from 'node:assert';
import {
  createMcpClient,
  createPaymentTestServer,
  assertSpendingRefused,
  getTestPayerKey,
} from './helpers/mcp.js';
import {
  stripUnsafeCharacters,
  assertSafeText,
  assertTransactionHash,
  assertNetwork,
  assertHttpUrl,
  frameUntrusted,
  createToolAuditLogger,
  sanitizeParamsForAudit,
} from '../src/mcp/sanitize.js';
import {
  executeInSandbox,
  validateAgainstInjection,
  validateObjectAgainstInjection,
  createSandboxedTool,
} from '../src/mcp/security.js';

test('MCP Server Spending Controls', async t => {
  const client = createMcpClient({
    AGENT_PAYER_SECRET_KEY: getTestPayerKey(),
    MAX_FEE_PER_CALL_STROOPS: '500',
    MAX_SESSION_SPEND_STROOPS: '1000',
  });
  const { server, url600 } = await createPaymentTestServer({});
  await t.test('enforces per-call cap (600 > 500)', async () => {
    try {
      await client.callTool('call_paid_resource', { url: url600 });
      assert.fail('Should have rejected');
    } catch (err) {
      assertSpendingRefused(err, /Spending refused.*exceeds per-call limit/);
    }
  });
  server.closeAllConnections();
  server.close();
  client.close();
});
test('MCP createMcpClient helper', async t => {
  await t.test('returns a client with callTool and close', () => {
    const client = createMcpClient({ AGENT_PAYER_SECRET_KEY: getTestPayerKey() });
    assert.equal(typeof client.callTool, 'function');
    assert.equal(typeof client.close, 'function');
    client.close();
  });
});
test('MCP helper assertions', async t => {
  await t.test('assertSpendingRefused matches spending refusal pattern', () => {
    const err = new Error(
      'Spending refused: Request amount (600 stroops) exceeds per-call limit (500 stroops).',
    );
    assert.doesNotThrow(() =>
      assertSpendingRefused(err, /Spending refused.*exceeds per-call limit/),
    );
  });
  await t.test('assertSpendingRefused throws on non-matching pattern', () => {
    const err = new Error('Some other error');
    assert.throws(() => assertSpendingRefused(err, /Spending refused/));
  });
  await t.test('getTestPayerKey returns a valid key', () => {
    const key = getTestPayerKey();
    assert.ok(key.startsWith('SBTJ'), 'Key should start with expected prefix');
    assert.equal(key.length > 0, true);
  });
});

test('MCP Input Sanitization & Validation', async t => {
  await t.test('stripUnsafeCharacters removes control characters', () => {
    const input = 'test\u0000\u001B[31m\u200B\u{E0000}hello';
    const result = stripUnsafeCharacters(input);
    assert.equal(result, 'testhello');
  });

  await t.test('stripUnsafeCharacters removes ANSI escapes', () => {
    const input = 'hello\u001B[31mworld\u001B[0m';
    const result = stripUnsafeCharacters(input);
    assert.equal(result, 'helloworld');
  });

  await t.test('assertSafeText validates required field', () => {
    assert.throws(() => assertSafeText('', { field: 'test', required: true }), /test.*required/);
  });

  await t.test('assertSafeText validates max length', () => {
    assert.throws(
      () => assertSafeText('x'.repeat(600), { field: 'test', maxLength: 512 }),
      /at most 512 characters/,
    );
  });

  await t.test('assertSafeText validates pattern', () => {
    assert.throws(
      () =>
        assertSafeText('invalid', {
          field: 'test',
          pattern: /^[0-9]+$/,
          patternHint: 'digits only',
        }),
      /malformed.*digits only/,
    );
  });

  await t.test('assertTransactionHash validates 64 hex chars', () => {
    const valid = 'a'.repeat(64);
    assert.equal(assertTransactionHash(valid), valid);

    assert.throws(() => assertTransactionHash('invalid'), /malformed/);

    assert.throws(() => assertTransactionHash('a'.repeat(65)), /at most 64 characters/);
  });

  await t.test('assertNetwork validates stellar network', () => {
    assert.equal(assertNetwork('stellar:testnet'), 'stellar:testnet');
    assert.equal(assertNetwork('stellar:pubnet'), 'stellar:pubnet');

    assert.throws(() => assertNetwork('stellar:invalid'), /malformed/);
  });

  await t.test('assertHttpUrl validates http/https only', () => {
    const url = assertHttpUrl('https://example.com');
    assert.equal(url.protocol, 'https:');

    assert.throws(() => assertHttpUrl('file:///etc/passwd'), /must use one of/);

    assert.throws(() => assertHttpUrl('javascript:alert(1)'), /must use one of/);
  });

  await t.test('frameUntrusted frames and bounds content', () => {
    const result = frameUntrusted('x'.repeat(2500), { maxLength: 100 });
    assert.ok(result.includes('[truncated]'));
    assert.ok(result.includes('BEGIN UNTRUSTED'));
    assert.ok(result.includes('END UNTRUSTED'));
  });
});

test('MCP Injection Guards', async t => {
  await t.test('validateAgainstInjection detects command injection', () => {
    assert.throws(
      () => validateAgainstInjection('test; rm -rf /', 'field'),
      /commandInjection|pathTraversal/,
    );

    assert.throws(
      () => validateAgainstInjection('test && cat /etc/passwd', 'field'),
      /commandInjection|pathTraversal/,
    );
  });

  await t.test('validateAgainstInjection detects path traversal', () => {
    assert.throws(() => validateAgainstInjection('../../../etc/passwd', 'field'), /pathTraversal/);

    assert.throws(
      () => validateAgainstInjection('..\\..\\windows\\system32', 'field'),
      /pathTraversal/,
    );
  });

  await t.test('validateAgainstInjection detects SQL injection', () => {
    assert.throws(
      () => validateAgainstInjection('SELECT * FROM users WHERE id = 1', 'field'),
      /sqlInjection/,
    );

    assert.throws(() => validateAgainstInjection('1; DROP TABLE users--', 'field'), /sqlInjection/);
  });

  await t.test('validateAgainstInjection detects script injection', () => {
    assert.throws(
      () => validateAgainstInjection('<script>alert(1)</script>', 'field'),
      /scriptInjection/,
    );

    assert.throws(
      () => validateAgainstInjection('javascript:alert(1)', 'field'),
      /scriptInjection/,
    );
  });

  await t.test('validateObjectAgainstInjection recurses into nested objects', () => {
    assert.throws(
      () => validateObjectAgainstInjection({ user: { input: 'test; rm -rf /' } }),
      /commandInjection/,
    );

    assert.throws(
      () => validateObjectAgainstInjection({ items: ['safe', 'bad; cmd'] }),
      /commandInjection/,
    );
  });

  await t.test('validateObjectAgainstInjection allows safe input', () => {
    assert.doesNotThrow(() =>
      validateObjectAgainstInjection({
        url: 'https://example.com',
        name: 'test',
        count: 42,
      }),
    );
  });
});

test('MCP Sandbox Execution', async t => {
  await t.test('executeInSandbox runs simple handler', async () => {
    const handler = async params => ({ result: params.value * 2 });
    const result = await executeInSandbox(handler, { value: 21 });
    assert.equal(result.result, 42);
  });

  await t.test('executeInSandbox enforces timeout', async () => {
    const handler = async () => {
      await new Promise(r => setTimeout(r, 1000));
      return { done: true };
    };

    await assert.rejects(
      executeInSandbox(handler, {}, { timeoutMs: 100 }),
      /timed out|execution_timeout/,
    );
  });

  await t.test('executeInSandbox enforces payload size limit', async () => {
    const handler = async () => ({ data: 'x'.repeat(2000000) });

    await assert.rejects(
      executeInSandbox(handler, {}, { maxPayloadSize: 1000 }),
      /exceeds maximum size|payload_too_large/,
    );
  });

  await t.test('createSandboxedTool validates input', async () => {
    const handler = async params => ({ result: params.input });
    const sandboxed = createSandboxedTool(handler, { validateInput: true });

    await assert.rejects(sandboxed({ input: 'test; rm -rf /' }), /commandInjection/);
  });

  await t.test('createSandboxedTool allows safe input', async () => {
    const handler = async params => ({ result: params.input });
    const sandboxed = createSandboxedTool(handler, { validateInput: true });

    const result = await sandboxed({ input: 'safe input' });
    assert.equal(result.result, 'safe input');
  });
});

test('MCP Tool Audit Logging', async t => {
  await t.test('createToolAuditLogger logs execution with timing', async () => {
    const logs = [];
    const auditFn = (event, entry) => logs.push({ event, ...entry });
    // Injected clock, because durationMs is a start/end pair: a real 10ms timer
    // reports 9 when Date.now() truncates the span, which made `>= 10` fail
    // intermittently on a loaded runner. The handler's span is now exact.
    let clock = 1_000;
    const logger = createToolAuditLogger(auditFn, { now: () => clock });

    await logger('test_tool', { input: 'test' }, async params => {
      clock += 12;
      return { output: params.input };
    });

    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'mcp_tool_execution');
    assert.equal(logs[0].toolName, 'test_tool');
    assert.equal(logs[0].startTime, 1_000);
    assert.equal(logs[0].endTime, 1_012);
    assert.equal(logs[0].durationMs, 12);
    assert.equal(logs[0].success, true);
    assert.equal(logs[0].parameters.input, 'test');
  });

  await t.test('createToolAuditLogger logs failed execution', async () => {
    const logs = [];
    const auditFn = (event, entry) => logs.push({ event, ...entry });
    const logger = createToolAuditLogger(auditFn);

    try {
      await logger('failing_tool', { input: 'test' }, async () => {
        throw new Error('tool failed');
      });
    } catch {
      // expected
    }

    assert.equal(logs.length, 1);
    assert.equal(logs[0].success, false);
    assert.ok(logs[0].error.includes('tool failed'));
  });

  await t.test('sanitizeParamsForAudit redacts sensitive fields', () => {
    const params = {
      apiKey: 'secret123',
      password: 'pass',
      normalField: 'value',
      nested: {
        secretToken: 'token123',
        safe: 'ok',
      },
    };

    const sanitized = sanitizeParamsForAudit(params);

    assert.equal(sanitized.apiKey, '[REDACTED]');
    assert.equal(sanitized.password, '[REDACTED]');
    assert.equal(sanitized.normalField, 'value');
    assert.equal(sanitized.nested.secretToken, '[REDACTED]');
    assert.equal(sanitized.nested.safe, 'ok');
  });
});
