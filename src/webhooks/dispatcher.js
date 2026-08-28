/**
 * Asynchronous webhook delivery over Kafka (#117).
 *
 * PROBLEM THIS EXISTS FOR. Delivering webhooks inline inside the settle
 * request's lifecycle couples our latency and connection budget to whatever
 * the receiving server feels like doing. A slow or unresponsive receiver
 * holds our sockets open until pools exhaust and global availability degrades.
 *
 * SHAPE OF THE FIX. The request path only *publishes*: it drops a message on
 * a Kafka topic and returns. Delivery happens in a separate consumer group
 * (see consumer.js) that owns the HTTP call and its retry policy — at-least-
 * once semantics from Kafka offsets, exponential backoff for receivers that
 * are down rather than slow.
 *
 * DEGRADATION. Without Kafka configured (KAFKA_BROKERS unset), enqueue falls
 * back to direct fire-and-forget delivery — still off the critical path, but
 * without durability across restarts. That keeps single-binary deployments
 * working while production runs get the queue.
 */

import crypto from 'node:crypto';

const DEFAULT_TOPIC = 'x402-webhook-delivery';
const DEFAULT_GROUP_ID = 'x402-webhook-dispatchers';
const DEFAULT_CLIENT_ID = 'x402-facilitator-stellar';

/**
 * Delivers one webhook payload with exponential backoff.
 *
 * Exported for the consumer and for tests; not used on the request path.
 *
 * @param {object} options
 * @param {string} options.url - receiver endpoint
 * @param {unknown} options.body - JSON-serializable payload
 * @param {Function} [options.fetchImpl] - injectable fetch
 * @param {number} [options.maxAttempts] - total attempts including the first
 * @param {number} [options.baseBackoffMs] - first backoff step; doubles per attempt
 * @param {(msg: string) => void} [options.warn]
 */
export async function deliverWebhook({
  url,
  body,
  fetchImpl = fetch,
  maxAttempts = 5,
  baseBackoffMs = 500,
  warn = msg => console.warn(msg),
}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // A receiver that answers is done — even an error status means the
      // endpoint exists and got the message; retrying a 410 forever serves
      // nobody. Only transport-level failures and 5xx are retried.
      if (res.status < 500) return { delivered: true, status: res.status };
      lastError = new Error(`webhook receiver returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts) {
      const backoff = baseBackoffMs * 2 ** (attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  warn(`webhook delivery to ${url} failed after ${maxAttempts} attempts: ${lastError?.message}`);
  return { delivered: false };
}

/**
 * Creates the webhook dispatcher used by the transport.
 *
 * With Kafka configured, enqueue() publishes to the topic and returns
 * immediately — the consumer group owns delivery. Without Kafka, enqueue()
 * hands off to the same background delivery logic so the critical path stays
 * clean either way.
 *
 * @param {object} [options]
 * @param {string[]} [options.brokers] - Kafka broker list; empty disables Kafka
 * @param {string} [options.clientId]
 * @param {string} [options.topic]
 * @param {string} [options.groupId]
 * @param {Function} [options.createKafka] - kafkajs factory (injectable for tests)
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{enqueue: Function, start: Function, stop: Function, kind: string}>}
 */
export async function createWebhookDispatcher({
  brokers = [],
  clientId = DEFAULT_CLIENT_ID,
  topic = DEFAULT_TOPIC,
  groupId = DEFAULT_GROUP_ID,
  /** Default receiver; events may override with their own url. */
  url = null,
  createKafka,
  fetchImpl,
  log = () => {},
  warn = msg => console.warn(msg),
} = {}) {
  /** The wire record, shared by the request-path enqueue and the outbox publish. */
  const buildRecord = event => ({
    id: event.id ?? crypto.randomUUID(),
    ...event,
    url: event.url ?? url,
    publishedAt: new Date().toISOString(),
  });

  if (!brokers.length) {
    log('webhooks: no Kafka brokers configured — delivering directly (no durability)');
    return {
      kind: 'direct',
      /** Fire-and-forget: never blocks or fails the caller. */
      enqueue(event) {
        const record = buildRecord(event);
        if (!record.url) return;
        Promise.resolve().then(() =>
          deliverWebhook({ url: record.url, body: record, warn, fetchImpl }),
        );
      },
      /**
       * Awaitable publish for the outbox worker (#123): direct delivery with
       * the retry policy, resolving only when a receiver answered. Throws when
       * there is no URL or every attempt failed — the worker then leaves the
       * event pending and retries on the next cycle.
       */
      async publish(event) {
        const record = buildRecord(event);
        if (!record.url) throw new Error('webhook delivery attempted without a receiver url');
        const res = await deliverWebhook({ url: record.url, body: record, warn, fetchImpl });
        if (!res.delivered) {
          throw new Error(
            `webhook delivery to ${record.url} failed after retries (last status ${res.status ?? 'transport error'})`,
          );
        }
        return record;
      },
      async start() {},
      async stop() {},
    };
  }

  const kafkajsFactory =
    createKafka ??
    (() => {
      // eslint-disable-next-line no-undef -- kafkajs ships CJS; require keeps the import lazy
      const { Kafka } = require('kafkajs');
      return new Kafka({ clientId, brokers });
    });
  const kafka = kafkajsFactory({ clientId, brokers });

  const producer = kafka.producer();
  const consumer = kafka.consumer({ groupId });
  let running = false;

  return {
    kind: 'kafka',

    /**
     * Publish-only. Never awaits delivery, never throws into the request path:
     * a webhook outage must not fail a settled payment.
     */
    enqueue(event) {
      const record = buildRecord(event);
      Promise.resolve()
        .then(async () => {
          await producer.send({
            topic,
            messages: [{ key: record.id, value: JSON.stringify(record) }],
          });
        })
        .catch(err => {
          // Last-resort fallback so a broker blip does not drop the event.
          warn(`webhooks: publish failed (${err.message}); delivering directly`);
          if (record.url) {
            deliverWebhook({ url: record.url, body: record, warn, fetchImpl }).catch(() => {});
          }
        });
    },

    /**
     * Awaitable publish for the outbox worker (#123): resolves only when the
     * broker acknowledged the message; throws on failure so the worker keeps
     * the event pending for the next cycle. No direct-delivery fallback here
     * — the outbox row IS the durability, and a fallback would double-send.
     */
    async publish(event) {
      const record = buildRecord(event);
      await producer.send({
        topic,
        messages: [{ key: record.id, value: JSON.stringify(record) }],
      });
      return record;
    },

    /** Starts the consumer group that performs actual delivery. */
    async start() {
      if (running) return;
      await producer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ message }) => {
          let record;
          try {
            record = JSON.parse(message.value.toString());
          } catch {
            warn('webhooks: dropping malformed message');
            return;
          }
          if (!record.url) return;
          await deliverWebhook({ url: record.url, body: record, warn, fetchImpl });
        },
      });
      running = true;
      log(`webhooks: consumer group "${groupId}" delivering topic "${topic}"`);
    },

    async stop() {
      if (!running) {
        await producer.disconnect().catch(() => {});
        return;
      }
      await consumer.stop();
      await producer.disconnect();
      running = false;
    },
  };
}
