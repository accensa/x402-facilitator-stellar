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
 *
 * DEAD-LETTERING. Every path that gives up on a message after exhausting
 * deliverWebhook's own retry budget — direct-mode enqueue, and the Kafka
 * consumer's eachMessage — records the message with the injected
 * DeadLetterStore (`dlq`) when one is configured, instead of the message
 * simply vanishing after the last warn(). The Kafka producer side also gets a
 * broker-level DLQ: when `dlqTopic` is set, a message the consumer could not
 * deliver is additionally published there for any other consumer watching the
 * dead-letter topic.
 *
 * AUTHENTICATION (#429). Every delivery is authenticated before it is sent, and
 * the mechanism is chosen per record rather than globally — an enterprise
 * endpoint presents a client certificate, everyone else gets an HMAC-SHA256
 * signature. See `src/webhooks/mtls.js` for why both exist and how the two
 * compose. The wire record carries only a credential *reference*, never key
 * material, so a broker hop does not expose a merchant's private key.
 */

import crypto from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { createDeliveryAuthenticator } from './mtls.js';

const DEFAULT_TOPIC = 'x402-webhook-delivery';
const DEFAULT_GROUP_ID = 'x402-webhook-dispatchers';
const DEFAULT_CLIENT_ID = 'x402-facilitator-stellar';

/**
 * Delivers one webhook payload with exponential backoff.
 *
 * Exported for the consumer and for tests; not used on the request path.
 *
 * The body is serialized ONCE and the same string is both signed and sent, so
 * the HMAC the receiver verifies is over the exact bytes on the wire — a
 * re-stringified body would differ in key order or whitespace and fail
 * verification at the far end even though nothing was tampered with.
 *
 * @param {object} options
 * @param {string} options.url - receiver endpoint
 * @param {unknown} options.body - JSON-serializable payload
 * @param {string} [options.payload] - a pre-serialized body, used verbatim
 *   instead of re-stringifying `body`. The dispatcher passes the exact bytes it
 *   signed so the HMAC covers precisely what goes on the wire.
 * @param {Function} [options.fetchImpl] - injectable fetch
 * @param {object} [options.dispatcher] - undici Agent carrying the merchant's
 *   client certificate (mTLS). Omitted for signature-only delivery.
 * @param {Record<string, string>} [options.headers] - authentication headers
 *   (the HMAC signature and its timestamp) added to the request
 * @param {number} [options.maxAttempts] - total attempts including the first
 * @param {number} [options.baseBackoffMs] - first backoff step; doubles per attempt
 * @param {(msg: string) => void} [options.warn]
 */
export async function deliverWebhook({
  url,
  body,
  payload: preSerialized,
  fetchImpl = undiciFetch,
  dispatcher = undefined,
  headers = {},
  maxAttempts = 5,
  baseBackoffMs = 500,
  warn = msg => console.warn(msg),
}) {
  const payload = preSerialized ?? JSON.stringify(body);
  const lastAttempt = attempt => attempt >= maxAttempts;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: payload,
        // undici reads `dispatcher` to pick the connection pool; a custom Agent
        // is what presents the client certificate. Absent for non-mTLS
        // delivery, which must keep using the default global pool.
        ...(dispatcher ? { dispatcher } : {}),
      });
      // A receiver that answers is done — even an error status means the
      // endpoint exists and got the message; retrying a 410 forever serves
      // nobody. Only transport-level failures and 5xx are retried.
      if (res.status < 500) return { delivered: true, status: res.status };
      lastError = new Error(`webhook receiver returned ${res.status}`);
    } catch (err) {
      lastError = err;
      // A certificate we cannot verify will not verify on the next attempt
      // either, so stop spending the budget and name the real cause.
      if (isCertificateRejection(err)) {
        warn(
          `webhook delivery to ${url} failed TLS certificate verification: ` +
            `${err.cause?.code ?? err.code} — not retrying`,
        );
        return { delivered: false, status: null, certificateRejected: true };
      }
    }
    if (attempt < maxAttempts && !lastAttempt(attempt)) {
      const backoff = baseBackoffMs * 2 ** (attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  warn(`webhook delivery to ${url} failed after ${maxAttempts} attempts: ${lastError?.message}`);
  return { delivered: false };
}

/**
 * True when a fetch failure was the TLS layer refusing a certificate — the half
 * of mTLS we can actually see.
 *
 * These are all failures where *we* are verifying the *receiver*: our CA bundle
 * does not cover the receiver's server certificate, the name does not match, or
 * the chain is self-signed (an interception attempt, or a private CA that was
 * never added to the endpoint's bundle). Retrying is pointless — the answer
 * will be identical every time — so delivery gives up immediately and the DLQ
 * records the real cause instead of "transport error" after five handshakes.
 *
 * The other half is not observable and deliberately not guessed at. When the
 * *receiver* rejects *our* client certificate, it aborts the handshake with a
 * TLS alert that Node does not surface: the client sees `UND_ERR_SOCKET`
 * ("other side closed"), which is indistinguishable from any other reset. So
 * that case is treated as an ordinary transport failure, retried, and
 * dead-lettered — the expiry pre-alert in mtls.js is what actually gets ahead
 * of a lapsed client certificate, because it fires days before the handshake
 * starts failing.
 *
 * Matching on `code` rather than on the message keeps this stable across Node
 * versions, whose TLS error strings are not contractual.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCertificateRejection(err) {
  if (!err) return false;
  const candidates = [err, err.cause, err.cause?.cause];
  return candidates.some(
    e =>
      e &&
      typeof e === 'object' &&
      (e.code === 'CERT_REQUIRED' ||
        e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        e.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        e.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        e.code === 'CERT_UNTRUSTED' ||
        // A receiver whose leaf is signed by a CA outside the endpoint's trust
        // bundle surfaces here rather than as SELF_SIGNED_CERT_IN_CHAIN, and is
        // the same non-retryable misconfiguration.
        e.code === 'CERT_SIGNATURE_FAILURE' ||
        e.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'),
  );
}

/** Records a message that exhausted its delivery budget, when a DLQ store is configured. */
async function recordDeadLetter({ dlq, source, record, error, deliveryAttempts, warn }) {
  if (!dlq) return;
  try {
    await dlq.insert({
      messageId: record.id,
      source,
      type: record.type,
      payload: record,
      error,
      deliveryAttempts,
    });
  } catch (err) {
    warn(`webhooks: DLQ insert failed for message ${record.id}: ${err.message}`);
  }
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
 * @param {string} [options.dlqTopic] - Kafka DLQ topic; a message the consumer
 *   could not deliver is republished here in addition to the `dlq` store, when set
 * @param {import('../dlq/store.js').DeadLetterStore} [options.dlq] - when given,
 *   messages that exhaust their delivery budget are recorded here instead of
 *   only logged and dropped
 * @param {Function} [options.createKafka] - kafkajs factory (injectable for tests)
 * @param {import('./mtls.js').MtlsCredentialProvider|null} [options.mtlsProvider]
 *   When set, a record carrying `mtls.ref` is delivered over a merchant client
 *   certificate. Omit it and every delivery is signature-only, which is the
 *   pre-#429 behaviour.
 * @param {Record<string, string>} [options.signingSecrets] - endpointId ->
 *   shared HMAC secret, for a single-node deployment. The Kafka consumer
 *   normally has only an endpointId, so prefer `resolveSigningSecret`.
 * @param {(record: object) => Promise<string|null>} [options.resolveSigningSecret]
 *   Vault/KMS lookup keyed on the record's endpointId.
 * @param {Function} [options.authenticate] - overrides the whole
 *   authentication step (injectable for tests that assert on headers/agent)
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{enqueue: Function, start: Function, stop: Function, kind: string}>}
 */
export async function createWebhookDispatcher({
  brokers = [],
  clientId = DEFAULT_CLIENT_ID,
  topic = DEFAULT_TOPIC,
  groupId = DEFAULT_GROUP_ID,
  dlqTopic = null,
  dlq = null,
  /** Default receiver; events may override with their own url. */
  url = null,
  createKafka,
  fetchImpl = undiciFetch,
  mtlsProvider = null,
  signingSecrets = {},
  resolveSigningSecret = null,
  authenticate = null,
  log = () => {},
  warn = msg => console.warn(msg),
} = {}) {
  /**
   * Decides the transport (plain vs client-certificate Agent) and the
   * authentication headers for one record. Built once here so all four delivery
   * paths below authenticate identically — the direct path and the Kafka
   * consumer must not be able to drift apart.
   */
  const authenticateDelivery =
    authenticate ??
    createDeliveryAuthenticator({
      mtlsProvider,
      signingSecrets,
      resolveSecret: resolveSigningSecret,
      warn,
      log,
    });

  /**
   * Authenticates and delivers one record with the shared retry policy.
   *
   * Single entry point for every send so the mTLS agent and the HMAC headers
   * can never be applied on one path and forgotten on another.
   */
  const deliver = async (record, { maxAttempts } = {}) => {
    const payload = JSON.stringify(record);
    const auth = await authenticateDelivery(record, payload);
    return deliverWebhook({
      url: record.url,
      body: record,
      // The bytes the authenticator signed, not a second serialization.
      payload,
      warn,
      fetchImpl,
      maxAttempts,
      ...auth,
    });
  };

  /**
   * The wire record, shared by the request-path enqueue and the outbox publish.
   *
   * `signingSecret` is stripped rather than spread: a caller that pasted the
   * material onto the event would otherwise put it into the Kafka topic and the
   * dead-letter store, where it would outlive the rotation that should have
   * retired it. Secrets are looked up per `endpointId` instead.
   */
  const buildRecord = event => {
    const { signingSecret: _neverOnTheWire, ...rest } = event ?? {};
    return {
      id: rest.id ?? crypto.randomUUID(),
      ...rest,
      url: rest.url ?? url,
      publishedAt: new Date().toISOString(),
    };
  };

  if (!brokers.length) {
    log('webhooks: no Kafka brokers configured — delivering directly (no durability)');
    return {
      kind: 'direct',
      /** Fire-and-forget: never blocks or fails the caller. */
      enqueue(event) {
        const record = buildRecord(event);
        if (!record.url) return;
        const maxAttempts = 5; // deliverWebhook's own default, named here for the DLQ record
        Promise.resolve().then(async () => {
          const res = await deliver(record, { maxAttempts });
          if (!res.delivered) {
            await recordDeadLetter({
              dlq,
              source: 'direct',
              record,
              error: `webhook delivery to ${record.url} failed after ${maxAttempts} attempts`,
              deliveryAttempts: maxAttempts,
              warn,
            });
          }
        });
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
        const res = await deliver(record);
        if (!res.delivered) {
          throw new Error(
            `webhook delivery to ${record.url} failed after retries (last status ${res.status ?? 'transport error'})`,
          );
        }
        return record;
      },
      async start() {},
      async stop() {
        // Release the pooled mTLS connections (and the key material they hold)
        // on shutdown rather than leaking them for the process's lifetime.
        await mtlsProvider?.closeAll?.();
      },
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
        .catch(async err => {
          // Last-resort fallback so a broker blip does not drop the event.
          warn(`webhooks: publish failed (${err.message}); delivering directly`);
          if (!record.url) return;
          const maxAttempts = 5;
          const res = await deliver(record, { maxAttempts }).catch(() => ({ delivered: false }));
          if (!res.delivered) {
            await recordDeadLetter({
              dlq,
              source: 'direct',
              record,
              error: `broker publish failed (${err.message}) and direct fallback delivery also failed`,
              deliveryAttempts: maxAttempts,
              warn,
            });
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
          const maxAttempts = 5;
          const res = await deliver(record, { maxAttempts });
          if (res.delivered) return;

          // Broker-level DLQ (issue: "Configure DLQs in the message broker"):
          // republish to the dead-letter topic for any other consumer watching
          // it, in addition to the operator-facing Postgres record below.
          if (dlqTopic) {
            await producer
              .send({
                topic: dlqTopic,
                messages: [{ key: record.id, value: JSON.stringify(record) }],
              })
              .catch(dlqErr => warn(`webhooks: DLQ topic publish failed: ${dlqErr.message}`));
          }

          await recordDeadLetter({
            dlq,
            source: 'kafka-consumer',
            record,
            error: `webhook delivery to ${record.url} failed after ${maxAttempts} attempts (last status ${res.status ?? 'transport error'})`,
            deliveryAttempts: maxAttempts,
            warn,
          });
        },
      });
      running = true;
      log(`webhooks: consumer group "${groupId}" delivering topic "${topic}"`);
    },

    async stop() {
      if (!running) {
        await producer.disconnect().catch(() => {});
        await mtlsProvider?.closeAll?.();
        return;
      }
      await consumer.stop();
      await producer.disconnect();
      // Close pooled mTLS connections after the consumer has drained, so an
      // in-flight delivery is not cut off mid-handshake.
      await mtlsProvider?.closeAll?.();
      running = false;
    },
  };
}
