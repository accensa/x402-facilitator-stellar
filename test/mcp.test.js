import test from 'node:test';
import assert from 'node:assert';
import {
  createMcpClient,
  createPaymentTestServer,
  assertSpendingRefused,
  getTestPayerKey,
} from './helpers/mcp.js';
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
