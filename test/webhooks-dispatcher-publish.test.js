import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookDispatcher } from '../src/webhooks/dispatcher.js';

test('publish throws when receiver url is missing and makes zero network calls', async () => {
  let calls = 0;
  const dispatcher = await createWebhookDispatcher({
    fetchImpl: async () => {
      calls++;
      return { status: 200 };
    },
  });

  await assert.rejects(
    () => dispatcher.publish({ type: 'settlement.completed' }),
    /webhook delivery attempted without a receiver url/,
  );
  assert.equal(calls, 0);
});

test('publish throws with the last status when all retries fail', async () => {
  let calls = 0;
  const dispatcher = await createWebhookDispatcher({
    baseBackoffMs: 1,
    fetchImpl: async () => {
      calls++;
      return { status: 503 };
    },
  });

  await assert.rejects(
    () =>
      dispatcher.publish({
        id: 'evt-1',
        type: 'settlement.completed',
        url: 'https://receiver.example/hook',
      }),
    /webhook delivery to https:\/\/receiver\.example\/hook failed after retries \(last status 503\)/,
  );
  assert.equal(calls, 6);
});

test('publish throws with transport-error wording when every attempt throws', async () => {
  let calls = 0;
  const dispatcher = await createWebhookDispatcher({
    baseBackoffMs: 1,
    fetchImpl: async () => {
      calls++;
      throw new Error('ECONNRESET');
    },
  });

  await assert.rejects(
    () =>
      dispatcher.publish({
        id: 'evt-2',
        type: 'settlement.completed',
        url: 'https://receiver.example/hook',
      }),
    /webhook delivery to https:\/\/receiver\.example\/hook failed after retries \(last status transport error\)/,
  );
  assert.equal(calls, 6);
});

test('publish resolves the record on immediate success', async () => {
  const dispatcher = await createWebhookDispatcher({
    fetchImpl: async () => ({ status: 200 }),
  });

  const record = {
    id: 'evt-3',
    type: 'settlement.completed',
    url: 'https://receiver.example/hook',
  };
  const result = await dispatcher.publish(record);
  assert.equal(result.id, record.id);
  assert.equal(result.url, record.url);
  assert.equal(result.type, record.type);
  assert.ok(result.publishedAt);
});

test('publish resolves after one failed attempt and one later success', async () => {
  let calls = 0;
  const dispatcher = await createWebhookDispatcher({
    baseBackoffMs: 1,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { status: 500 };
      return { status: 200 };
    },
  });

  const record = {
    id: 'evt-4',
    type: 'settlement.completed',
    url: 'https://receiver.example/hook',
  };
  const result = await dispatcher.publish(record);
  assert.equal(result.id, record.id);
  assert.equal(result.url, record.url);
  assert.equal(result.type, record.type);
  assert.ok(result.publishedAt);
  assert.equal(calls, 2);
});
