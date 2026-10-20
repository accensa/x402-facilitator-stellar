import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { PROMPTS_BY_NAME } from '../src/mcp/prompts.js';

/**
 * Protocol tests for the documented prompts/get error contract (#514).
 *
 * docs/MCP.md:150 promises a two-tier contract: an unknown prompt name or a
 * malformed argument in prompts/get returns result.isError with
 * content[0].text holding {"code":"invalid_input","message":...} plus
 * validPrompts or the offending field. The templates themselves
 * (generate_payment_uri, query_dispute_status, audit_transaction) and the
 * GROUND_RULES preamble were equally unasserted. Every row has an assertion
 * here, driven through McpServer the way test/mcp-server.test.js does.
 */

const VALID_HASH = 'a'.repeat(64);
const VALID_PAYEE = `G${'A'.repeat(55)}`;

function makeServer(options = {}) {
  const server = new McpServer({ name: 'prompts-test', version: '0.0.1', ...options });
  const sent = [];
  server._sendResult = (id, result) => sent.push({ kind: 'result', id, result });
  server._sendError = (id, code, message, data) => {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    sent.push({ kind: 'error', id, error });
  };
  return { server, sent };
}

const call = (server, id, method, params = {}) =>
  server._handleRequest({ jsonrpc: '2.0', id, method, params });

function parseIsError(result) {
  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

describe('prompts/list advertises the three documented templates', () => {
  test('returns generate_payment_uri, query_dispute_status, audit_transaction', async () => {
    const { server, sent } = makeServer();
    await call(server, 1, 'prompts/list');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'result');
    const names = sent[0].result.prompts.map(p => p.name).sort();
    assert.deepEqual(names, ['audit_transaction', 'generate_payment_uri', 'query_dispute_status']);
  });

  test('argument schemas match docs/MCP.md', async () => {
    const { server, sent } = makeServer();
    await call(server, 1, 'prompts/list');

    const byName = new Map(sent[0].result.prompts.map(p => [p.name, p]));
    const gen = byName.get('generate_payment_uri');
    assert.ok(gen.description.length > 0);
    assert.deepEqual(
      gen.arguments.map(a => [a.name, a.required]),
      [
        ['resource_url', true],
        ['network', false],
        ['max_amount_stroops', false],
      ],
    );

    const dispute = byName.get('query_dispute_status');
    assert.deepEqual(
      dispute.arguments.map(a => [a.name, a.required]),
      [
        ['transaction_hash', true],
        ['network', false],
      ],
    );

    const audit = byName.get('audit_transaction');
    assert.deepEqual(
      audit.arguments.map(a => [a.name, a.required]),
      [
        ['transaction_hash', true],
        ['network', false],
        ['expected_payee', false],
        ['include_timeline', false],
      ],
    );
  });
});

describe('prompts/get renders each template with the ground-rules preamble', () => {
  test('generate_payment_uri renders with url, network and preamble', async () => {
    const { server, sent } = makeServer();
    await call(server, 1, 'prompts/get', {
      name: 'generate_payment_uri',
      arguments: { resource_url: 'https://example.com/item', network: 'stellar:testnet' },
    });

    assert.equal(sent[0].kind, 'result');
    const { description, messages } = sent[0].result;
    assert.ok(description.includes('example.com'));
    const text = messages[0].content.text;
    assert.ok(text.includes('Ground rules for this task:'), 'must carry the GROUND_RULES preamble');
    assert.ok(text.includes('BEGIN/END'), 'preamble must name the data-block convention');
    assert.ok(text.includes('https://example.com/item'), 'must name the resource');
    assert.ok(text.includes('stellar:testnet'), 'must name the network');
  });

  test('query_dispute_status renders with hash and preamble', async () => {
    const { server, sent } = makeServer();
    await call(server, 1, 'prompts/get', {
      name: 'query_dispute_status',
      arguments: { transaction_hash: VALID_HASH },
    });

    const text = sent[0].result.messages[0].content.text;
    assert.ok(text.includes('Ground rules for this task:'));
    assert.ok(text.includes(VALID_HASH), 'must name the hash');
  });

  test('audit_transaction renders with hash, payee and preamble', async () => {
    const { server, sent } = makeServer();
    await call(server, 1, 'prompts/get', {
      name: 'audit_transaction',
      arguments: { transaction_hash: VALID_HASH, expected_payee: VALID_PAYEE },
    });

    const text = sent[0].result.messages[0].content.text;
    assert.ok(text.includes('Ground rules for this task:'));
    assert.ok(text.includes(VALID_HASH));
    assert.ok(text.includes(VALID_PAYEE));
  });
});

describe('docs/MCP.md:150 prompt-error contract', () => {
  test('unknown prompt name yields isError with validPrompts', async () => {
    const { server, sent } = makeServer();
    await call(server, 1, 'prompts/get', { name: 'no_such_prompt', arguments: {} });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'result', 'unknown prompt is a tool error, not a protocol error');
    const payload = parseIsError(sent[0].result);
    assert.equal(payload.code, 'invalid_input');
    assert.ok(typeof payload.message === 'string');
    assert.deepEqual(
      [...payload.validPrompts].sort(),
      [...PROMPTS_BY_NAME.keys()].sort(),
      'validPrompts must track PROMPTS_BY_NAME so a rename fails CI',
    );
    assert.deepEqual([...payload.validPrompts].sort(), [
      'audit_transaction',
      'generate_payment_uri',
      'query_dispute_status',
    ]);
  });

  test('malformed arguments yield isError naming the field', async () => {
    const cases = [
      {
        name: 'generate_payment_uri',
        args: { resource_url: 'not-a-url' },
        field: 'resource_url',
      },
      {
        name: 'query_dispute_status',
        args: { transaction_hash: 'short' },
        field: 'transaction_hash',
      },
      {
        name: 'audit_transaction',
        args: { transaction_hash: VALID_HASH, expected_payee: 'not-a-payee' },
        field: 'expected_payee',
      },
    ];

    for (const { name, args, field } of cases) {
      const { server, sent } = makeServer();
      await call(server, 1, 'prompts/get', { name, arguments: args });

      assert.equal(
        sent[0].kind,
        'result',
        `${name} malformed arg must be isError, not a protocol error`,
      );
      const payload = parseIsError(sent[0].result);
      assert.equal(payload.code, 'invalid_input');
      assert.equal(payload.field, field, `must name the offending field (${field})`);
    }
  });

  test('non-object arguments do not crash the server', async () => {
    for (const badArgs of ['oops', 42, ['x']]) {
      const { server, sent } = makeServer();
      await call(server, 1, 'prompts/get', {
        name: 'generate_payment_uri',
        arguments: badArgs,
      });

      assert.equal(sent.length, 1, 'a notification-style bad arg must still be answered');
      assert.equal(sent[0].kind, 'result', 'non-object args are a tool error, not -32603');
      const payload = parseIsError(sent[0].result);
      assert.equal(payload.code, 'invalid_input');

      // The server is still usable afterwards.
      sent.length = 0;
      await call(server, 2, 'prompts/get', {
        name: 'query_dispute_status',
        arguments: { transaction_hash: VALID_HASH },
      });
      assert.equal(sent[0].kind, 'result');
      assert.equal(sent[0].result.isError, undefined);
    }
  });
});

describe('audit_transaction include_timeline coercion (src/mcp/prompts.js:201)', () => {
  test('true and "true" both render the timeline; false/absent do not', async () => {
    // Intentional: the template accepts boolean true and string 'true' alike,
    // so a future cleanup must not silently change the coercion.
    async function renderTimeline(args) {
      const { server, sent } = makeServer();
      await call(server, 1, 'prompts/get', {
        name: 'audit_transaction',
        arguments: { transaction_hash: VALID_HASH, ...args },
      });
      return sent[0].result.messages[0].content.text;
    }

    const withBool = await renderTimeline({ include_timeline: true });
    const withString = await renderTimeline({ include_timeline: 'true' });
    const withFalse = await renderTimeline({ include_timeline: false });
    const absent = await renderTimeline({});

    assert.ok(withBool.includes('timeline'), 'boolean true renders the timeline');
    assert.ok(withString.includes('timeline'), 'string "true" renders the timeline');
    assert.ok(!withFalse.includes('timeline'), 'false must not render the timeline');
    assert.ok(!absent.includes('timeline'), 'absent must not render the timeline');
  });
});
