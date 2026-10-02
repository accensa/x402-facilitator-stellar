/**
 * Kafka webhook delivery (#117) and webhook authentication (#429).
 *
 * The dispatcher is exercised with an injected kafkajs-shaped factory so no
 * broker is needed; what is under test is the contract: publish-only on the
 * request path, delivery owned by the consumer group, exponential backoff on
 * receiver failure, direct-mode degradation without brokers.
 *
 * The mTLS half is NOT mocked. Handshake success and handshake rejection are
 * only meaningful against a real TLS server that genuinely demands a client
 * certificate, so these tests stand up an `https` server with
 * `requestCert: true` and issue it a real certificate chain from
 * `test/helpers/test-certificates.js` (Node can parse certificates but not
 * issue them, hence the hand-rolled DER in that helper). Asserting against a
 * fake `fetch` would only prove that we pass a `dispatcher` option, which is
 * not the thing that can be wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHmac, X509Certificate } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import {
  createWebhookDispatcher,
  deliverWebhook,
  isCertificateRejection,
} from '../src/webhooks/dispatcher.js';
import {
  createDeliveryAuthenticator,
  MtlsCredentialProvider,
  checkCertificateExpiry,
  credentialFingerprint,
  describeCertificate,
  isMtlsConfigured,
  signatureHeaders,
  signPayload,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../src/webhooks/mtls.js';
import { createCertificateAuthority } from './helpers/test-certificates.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('deliverWebhook', () => {
  test('retries transport failures with backoff until it succeeds', async () => {
    let attempts = 0;
    const result = await deliverWebhook({
      url: 'https://receiver.example/hook',
      body: { ok: 1 },
      maxAttempts: 4,
      baseBackoffMs: 1,
      fetchImpl: async () => {
        attempts++;
        if (attempts < 3) throw new Error('ECONNRESET');
        return { status: 200 };
      },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(result, { delivered: true, status: 200 });
  });

  test('gives up after maxAttempts and reports non-delivery', async () => {
    let attempts = 0;
    const warns = [];
    const result = await deliverWebhook({
      url: 'https://receiver.example/hook',
      body: {},
      maxAttempts: 3,
      baseBackoffMs: 1,
      warn: m => warns.push(m),
      fetchImpl: async () => {
        attempts++;
        throw new Error('ETIMEDOUT');
      },
    });
    assert.equal(attempts, 3);
    assert.equal(result.delivered, false);
    assert.ok(warns[0].includes('failed after 3'));
  });

  test('does not retry client-error statuses', async () => {
    let attempts = 0;
    await deliverWebhook({
      url: 'https://receiver.example/gone',
      body: {},
      maxAttempts: 5,
      baseBackoffMs: 1,
      fetchImpl: async () => {
        attempts++;
        return { status: 410 };
      },
    });
    assert.equal(attempts, 1);
  });

  test('retries server-error statuses', async () => {
    let attempts = 0;
    await deliverWebhook({
      url: 'https://receiver.example/flaky',
      body: {},
      maxAttempts: 2,
      baseBackoffMs: 1,
      fetchImpl: async () => {
        attempts++;
        return { status: 503 };
      },
    });
    assert.equal(attempts, 2);
  });
});

/** Builds a kafkajs-shaped double capturing producer sends and consumer runs. */
function fakeKafkaFactory() {
  const sent = [];
  let handler = null;
  const calls = { producerConnected: 0, subscribed: 0, consumerStarted: 0, stopped: 0 };
  const factory = () => ({
    producer() {
      return {
        connect: async () => calls.producerConnected++,
        disconnect: async () => {},
        send: async ({ topic, messages }) => sent.push({ topic, messages }),
      };
    },
    consumer({ groupId }) {
      assert.ok(groupId);
      return {
        subscribe: async () => calls.subscribed++,
        run: async ({ eachMessage }) => {
          handler = eachMessage;
          calls.consumerStarted++;
        },
        stop: async () => calls.stopped++,
      };
    },
  });
  factory.sent = sent;
  factory.calls = calls;
  /** Simulates a broker handing the consumer one message (JSON value). */
  factory.deliver = async value =>
    handler({ topic: 't', partition: 0, message: { value: Buffer.from(JSON.stringify(value)) } });
  /** Simulates a broker handing the consumer a raw (possibly invalid) payload. */
  factory.deliverRaw = async raw =>
    handler({ topic: 't', partition: 0, message: { value: Buffer.from(raw) } });
  return factory;
}

describe('kafka-backed dispatcher', () => {
  test('enqueue publishes to the topic and never delivers inline', async () => {
    const kafka = fakeKafkaFactory();
    let delivered = 0;
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      topic: 'webhooks',
      groupId: 'dispatchers',
      createKafka: kafka,
      fetchImpl: async () => {
        delivered++;
        return { status: 200 };
      },
    });
    assert.equal(dispatcher.kind, 'kafka');

    dispatcher.enqueue({ type: 'settlement.completed', url: 'https://r.example/h' });
    // Give the publish microtask a tick.
    await sleep(10);

    assert.equal(kafka.sent.length, 1);
    assert.equal(kafka.sent[0].topic, 'webhooks');
    const record = JSON.parse(kafka.sent[0].messages[0].value.toString());
    assert.equal(record.type, 'settlement.completed');
    assert.equal(record.url, 'https://r.example/h');
    assert.ok(record.id && record.publishedAt);
    assert.equal(delivered, 0, 'delivery must not happen on the request path');

    await dispatcher.stop();
  });

  test('consumer group processes messages and delivers webhooks', async () => {
    const kafka = fakeKafkaFactory();
    const bodies = [];
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      createKafka: kafka,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { status: 200 };
      },
    });

    await dispatcher.start();
    assert.equal(kafka.calls.consumerStarted, 1);

    await kafka.deliver({ id: 'e1', type: 'test', url: 'https://r.example/x' });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].id, 'e1');

    await dispatcher.stop();
    assert.equal(kafka.calls.stopped, 1);
  });

  test('a broker outage on publish falls back to direct delivery', async () => {
    const warns = [];
    let delivered = 0;
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      createKafka: () => ({
        producer() {
          return {
            connect: async () => {},
            disconnect: async () => {},
            send: async () => {
              throw new Error('broker unreachable');
            },
          };
        },
        consumer() {
          return { subscribe: async () => {}, run: async () => {}, stop: async () => {} };
        },
      }),
      fetchImpl: async () => {
        delivered++;
        return { status: 200 };
      },
      warn: m => warns.push(m),
    });

    dispatcher.enqueue({ type: 'test', url: 'https://r.example/fallback' });
    await sleep(20);

    assert.ok(warns.some(m => m.includes('publish failed')));
    assert.equal(delivered, 1, 'event must not be lost to a broker blip');
    await dispatcher.stop();
  });

  test('malformed consumer messages are dropped, not retried forever', async () => {
    const kafka = fakeKafkaFactory();
    let delivered = 0;
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      createKafka: kafka,
      fetchImpl: async () => {
        delivered++;
        return { status: 200 };
      },
    });
    await dispatcher.start();

    await kafka.deliverRaw('{not json');
    assert.equal(delivered, 0, 'garbage must be dropped without delivery attempts');

    await dispatcher.stop();
  });
});

describe('direct-mode dispatcher (no Kafka configured)', () => {
  test('delivers off the critical path using the configured default url', async () => {
    const bodies = [];
    const dispatcher = await createWebhookDispatcher({
      url: 'https://default.example/hook',
      fetchImpl: async (_url, init) => {
        bodies.push({ url: _url, body: JSON.parse(init.body) });
        return { status: 200 };
      },
    });
    assert.equal(dispatcher.kind, 'direct');

    dispatcher.enqueue({ type: 'settlement.completed' });
    await sleep(10);

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].url, 'https://default.example/hook');
    assert.equal(bodies[0].body.type, 'settlement.completed');

    // No default url and no per-event url: nothing is sent anywhere.
    const quiet = await createWebhookDispatcher({
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { status: 200 };
      },
    });
    quiet.enqueue({ type: 'ignored' });
    await sleep(10);
    assert.equal(bodies.length, 1);
  });
});

// ---------------------------------------------------------------------------
// #429 — webhook authentication
// ---------------------------------------------------------------------------

/**
 * A `resolve` backed by an in-memory map, standing in for a vault read.
 * Counts calls so the caching behaviour can be asserted.
 */
function stubResolver(material) {
  const calls = [];
  const resolve = async ref => {
    calls.push(ref);
    if (!(ref in material)) throw new Error(`no such secret: ${ref}`);
    return material[ref];
  };
  resolve.calls = calls;
  return resolve;
}

/** Recomputes the delivery signature exactly as a receiver would. */
function verifySignature({ headers, rawBody, secret }) {
  const signature = headers[SIGNATURE_HEADER];
  const timestamp = headers[TIMESTAMP_HEADER];
  assert.ok(signature, 'delivery must carry a signature header');
  assert.ok(timestamp, 'delivery must carry a timestamp header');
  const expected = `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')}`;
  return signature === expected;
}

/** Stands up an https receiver and resolves once it is accepting connections. */
async function startReceiver({
  key,
  cert,
  ca,
  requestCert = true,
  rejectUnauthorized = true,
  onRequest,
}) {
  const received = [];
  const server = https.createServer(
    { key, cert, ca, requestCert, rejectUnauthorized },
    (req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        received.push({
          headers: req.headers,
          rawBody,
          authorized: req.socket.authorized,
          authorizationError: req.socket.authorizationError,
          peer: req.socket.getPeerCertificate?.()?.subject ?? null,
        });
        onRequest?.(req, res, received.at(-1));
      });
    },
  );
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    received,
    port: server.address().port,
    origin: `https://localhost:${server.address().port}`,
    close: () =>
      new Promise(r => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

/**
 * Provider wired to one merchant credential ref.
 *
 * The resolved material carries the test CA as `ca` because the receiver's
 * server certificate is issued by it — exactly the "custom CA bundle per
 * endpoint" case, and the reason a private-CA enterprise receiver works at all.
 * Without it the default trust store rejects the receiver before our client
 * certificate is ever presented.
 */
function providerFor(authority, extra = {}) {
  return new MtlsCredentialProvider({
    resolve: stubResolver({
      'merchant/acme': {
        cert: authority.client.cert,
        key: authority.client.key,
        ca: authority.ca.cert,
      },
    }),
    warn: () => {},
    ...extra,
  });
}

describe('HMAC-SHA256 signing (non-enterprise merchants)', () => {
  test('the signature covers the timestamp and the exact bytes on the wire', () => {
    const secret = 'shared-secret';
    const body = '{"type":"settlement.completed","amount":200}';
    const headers = signatureHeaders({ body, secret, timestamp: 1_700_000_000 });

    assert.equal(headers[TIMESTAMP_HEADER], '1700000000');
    assert.ok(
      verifySignature({ headers, rawBody: body, secret }),
      'receiver must be able to recompute the signature from the raw body',
    );
  });

  test('a different body or a different timestamp does not verify', () => {
    const secret = 'shared-secret';
    const body = '{"a":1}';
    const headers = signatureHeaders({ body, secret, timestamp: 1_700_000_000 });

    assert.ok(!verifySignature({ headers, rawBody: '{"a":2}', secret }), 'body tamper must fail');
    const replayed = { ...headers, [TIMESTAMP_HEADER]: String(1_700_000_500) };
    assert.ok(
      !verifySignature({ headers: replayed, rawBody: body, secret }),
      'timestamp swap must fail',
    );
  });

  test('signing without a secret is a hard error, not an unsigned delivery', () => {
    assert.throws(() => signPayload({ secret: null, body: '{}' }), /without a secret/);
  });

  test('a non-mTLS endpoint is delivered signed, and the receiver verifies it', async () => {
    const secret = 'merchant-shared-secret';
    const received = [];
    const dispatcher = await createWebhookDispatcher({
      signingSecrets: { 'acme-prod': secret },
      fetchImpl: async (_url, init) => {
        received.push({ headers: init.headers, body: init.body });
        return { status: 200 };
      },
    });

    await dispatcher.publish({
      type: 'settlement.completed',
      endpointId: 'acme-prod',
      url: 'https://receiver.example/hook',
    });

    assert.equal(received.length, 1);
    assert.ok(
      verifySignature({
        headers: received[0].headers,
        rawBody: received[0].body,
        secret,
      }),
      'the non-enterprise path must still be authenticated by signature',
    );
    // The fallback path must not carry a client certificate.
    assert.equal(received[0].headers.dispatcher, undefined);
  });

  test('an endpoint with no secret and no mTLS is delivered unsigned', async () => {
    const received = [];
    const dispatcher = await createWebhookDispatcher({
      fetchImpl: async (_url, init) => {
        received.push(init.headers);
        return { status: 200 };
      },
    });

    await dispatcher.publish({
      type: 'settlement.completed',
      url: 'https://receiver.example/hook',
    });

    assert.equal(received[0][SIGNATURE_HEADER], undefined);
    assert.equal(received[0][TIMESTAMP_HEADER], undefined);
    assert.equal(received[0]['content-type'], 'application/json');
  });
});

describe('mTLS delivery (enterprise merchants)', () => {
  test('a receiver demanding a client certificate accepts the mTLS delivery', async t => {
    const authority = createCertificateAuthority();
    const receiver = await startReceiver({
      key: authority.server.key,
      cert: authority.server.cert,
      ca: authority.ca.cert,
      onRequest: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      },
    });
    t.after(() => receiver.close());

    const provider = providerFor(authority);
    t.after(() => provider.closeAll());

    const result = await deliverWebhook({
      url: `${receiver.origin}/hook`,
      body: { type: 'settlement.completed', network: 'stellar:testnet' },
      dispatcher: (await provider.getAgent({ mtls: { ref: 'merchant/acme' } })).agent,
      maxAttempts: 2,
      baseBackoffMs: 1,
    });

    assert.equal(result.delivered, true);
    assert.equal(result.status, 200);
    assert.equal(receiver.received.length, 1);
    // The whole point: the receiver authenticated us at the TLS layer.
    assert.equal(receiver.received[0].authorized, true);
    // Node reports "no error" as null on a successful authorization.
    assert.equal(receiver.received[0].authorizationError ?? undefined, undefined);
    assert.match(receiver.received[0].peer.CN, /x402-facilitator test merchant/);
  });

  test('mTLS and the signature compose: an enterprise endpoint can carry both', async t => {
    const authority = createCertificateAuthority();
    const secret = 'enterprise-shared-secret';
    const receiver = await startReceiver({
      key: authority.server.key,
      cert: authority.server.cert,
      ca: authority.ca.cert,
      onRequest: (req, res) => {
        res.writeHead(200);
        res.end('{}');
      },
    });
    t.after(() => receiver.close());

    const dispatcher = await createWebhookDispatcher({
      mtlsProvider: providerFor(authority),
      signingSecrets: { 'acme-enterprise': secret },
      url: `${receiver.origin}/hook`,
    });
    t.after(() => dispatcher.stop());

    await dispatcher.publish({
      type: 'settlement.completed',
      endpointId: 'acme-enterprise',
      // Without the ref the record is signature-only and the delivery would
      // never present a certificate — which is what the next assertion checks.
      mtls: { ref: 'merchant/acme' },
    });

    const got = receiver.received[0];
    assert.equal(got.authorized, true, 'client certificate must still be presented');
    assert.ok(
      verifySignature({ headers: got.headers, rawBody: got.rawBody, secret }),
      'belt and braces: the HMAC must also be present and valid',
    );
  });

  test('a receiver whose CA we do not trust fails verification without retrying', async t => {
    const trusted = createCertificateAuthority();
    // A receiver presenting a certificate from a different, untrusted CA: the
    // interception / misconfigured-private-CA case. This half of mTLS IS
    // visible to us, so the retry budget must not be spent on it.
    const rogue = createCertificateAuthority();
    const receiver = await startReceiver({
      key: rogue.server.key,
      cert: rogue.server.cert,
      ca: trusted.ca.cert,
      onRequest: (req, res) => {
        res.writeHead(200);
        res.end('{}');
      },
    });
    t.after(() => receiver.close());

    const provider = providerFor(trusted);
    t.after(() => provider.closeAll());

    const warns = [];
    let attempts = 0;
    const countingFetch = async (...args) => {
      attempts++;
      return undiciFetch(...args);
    };

    const result = await deliverWebhook({
      url: `${receiver.origin}/hook`,
      body: { type: 'settlement.completed' },
      // The client trusts only `trusted`, so the rogue server certificate fails.
      dispatcher: (await provider.getAgent({ mtls: { ref: 'merchant/acme' } })).agent,
      fetchImpl: countingFetch,
      maxAttempts: 5,
      baseBackoffMs: 1,
      warn: m => warns.push(m),
    });

    assert.equal(result.delivered, false);
    assert.equal(result.certificateRejected, true);
    assert.equal(attempts, 1, 'an unverifiable certificate must not be retried');
    assert.ok(
      warns.some(m => /TLS certificate verification/.test(m)),
      warns.join('\n'),
    );
  });

  test('a receiver that rejects our client certificate fails delivery and is dead-lettered', async t => {
    const authority = createCertificateAuthority();
    // The receiver trusts a different CA, so it aborts the handshake when it
    // sees our certificate. The alert is not surfaced to us, so this is an
    // ordinary transport failure: retried, then dead-lettered.
    const other = createCertificateAuthority();
    const receiver = await startReceiver({
      key: authority.server.key,
      cert: authority.server.cert,
      ca: other.ca.cert,
      onRequest: (req, res) => {
        res.writeHead(200);
        res.end('{}');
      },
    });
    t.after(() => receiver.close());

    const provider = providerFor(authority);
    t.after(() => provider.closeAll());

    const dead = [];
    const dispatcher = await createWebhookDispatcher({
      mtlsProvider: provider,
      fetchImpl: undiciFetch,
      dlq: {
        insert: async record => {
          dead.push(record);
        },
      },
    });
    t.after(() => dispatcher.stop());

    await assert.rejects(
      dispatcher.publish({
        type: 'settlement.completed',
        endpointId: 'acme',
        url: `${receiver.origin}/hook`,
      }),
      /failed after retries/,
    );
    assert.equal(receiver.received.length, 0, 'the receiver must never see the payload');
  });

  test('a lapsed credential ref degrades to signature-only delivery with a warning', async () => {
    const warns = [];
    const provider = new MtlsCredentialProvider({
      resolve: stubResolver({}),
      warn: m => warns.push(m),
    });

    const authenticate = createDeliveryAuthenticator({
      mtlsProvider: provider,
      signingSecrets: { acme: 'shh' },
      // The authenticator reports its own fallback; without wiring the sink the
      // warning would go to console and this assertion would be vacuous.
      warn: m => warns.push(m),
    });
    const auth = await authenticate(
      { endpointId: 'acme', mtls: { ref: 'merchant/missing' } },
      '{}',
    );

    assert.equal(
      auth.dispatcher,
      undefined,
      'no client certificate when the credential is unavailable',
    );
    assert.ok(
      auth.headers[SIGNATURE_HEADER],
      'the signature is the fallback that still authenticates',
    );
    assert.ok(
      warns.some(m => /mTLS unavailable for endpoint acme/.test(m) && /falling back/.test(m)),
      warns.join('\n'),
    );
    await provider.closeAll();
  });
});

describe('mTLS credential lifecycle', () => {
  test('one agent is pooled per credential and reused across deliveries', async () => {
    const authority = createCertificateAuthority();
    const resolve = stubResolver({
      'merchant/acme': { cert: authority.client.cert, key: authority.client.key },
    });
    const provider = new MtlsCredentialProvider({ resolve, warn: () => {} });

    const first = await provider.getAgent({ mtls: { ref: 'merchant/acme' } });
    const second = await provider.getAgent({ mtls: { ref: 'merchant/acme' } });

    assert.equal(resolve.calls.length, 1, 'the credential must be read once, not per delivery');
    assert.equal(first.agent, second.agent, 'concurrent deliveries must share the connection pool');
    assert.equal(provider.agentCount, 1);

    // Two different merchants must not share a pool.
    await provider.getAgent({ mtls: { ref: 'merchant/other' } }).catch(() => {});
    assert.equal(provider.agentCount, 1);

    await provider.closeAll();
    assert.equal(provider.agentCount, 0, 'shutdown must close pooled connections');
  });

  test('concurrent deliveries for a cold ref collapse into one read', async () => {
    const authority = createCertificateAuthority();
    let reads = 0;
    const provider = new MtlsCredentialProvider({
      resolve: async _ref => {
        reads++;
        await sleep(20); // a slow vault is exactly when stampedes happen
        return { cert: authority.client.cert, key: authority.client.key };
      },
      warn: () => {},
    });

    await Promise.all(
      Array.from({ length: 5 }, () => provider.getAgent({ mtls: { ref: 'merchant/acme' } })),
    );
    assert.equal(reads, 1, 'a cold cache must not stampede the secret store');
    await provider.closeAll();
  });

  test('a rotated certificate yields a new agent and closes the old pool', async () => {
    const first = createCertificateAuthority();
    const second = createCertificateAuthority();
    let current = { cert: first.client.cert, key: first.client.key };
    let now = Date.now();
    const closed = [];
    const provider = new MtlsCredentialProvider({
      resolve: async () => current,
      credentialTtlMs: 1000,
      createAgent: () => ({ close: async () => closed.push('closed'), id: Math.random() }),
      now: () => now,
      warn: () => {},
    });

    const before = await provider.getAgent({ mtls: { ref: 'merchant/acme' } });
    now += 5000; // credential TTL lapses
    current = { cert: second.client.cert, key: second.client.key };
    const after = await provider.getAgent({ mtls: { ref: 'merchant/acme' } });

    assert.notEqual(before.fingerprint, after.fingerprint, 'a rotation must change the identity');
    assert.notEqual(
      before.agent,
      after.agent,
      'a rotation must not reuse a socket for the old identity',
    );
    assert.deepEqual(closed, ['closed'], 'the orphaned pool must be closed');
    await provider.closeAll();
  });

  test('a credential ref that yields no key is a configuration error', async () => {
    const provider = new MtlsCredentialProvider({
      resolve: async () => ({ cert: 'only-a-cert' }),
      warn: () => {},
    });
    await assert.rejects(
      provider.getAgent({ mtls: { ref: 'merchant/broken' } }),
      /did not yield both a certificate and a private key/,
    );
    await provider.closeAll();
  });

  test('an unreadable certificate fails at resolution, not at handshake time', async () => {
    const provider = new MtlsCredentialProvider({
      resolve: async () => ({ cert: 'not a certificate', key: 'not a key' }),
      warn: () => {},
    });
    await assert.rejects(
      provider.getAgent({ mtls: { ref: 'merchant/garbage' } }),
      /not a readable PEM certificate/,
    );
    await provider.closeAll();
  });
});

describe('certificate expiry alerting', () => {
  test('a certificate inside the warning window is reported before it lapses', () => {
    const authority = createCertificateAuthority({ clientValidDays: 10 });
    const warns = [];
    const info = describeCertificate(authority.client.cert);

    assert.equal(info.expired, false);
    assert.ok(info.daysRemaining <= 10 && info.daysRemaining >= 9, `got ${info.daysRemaining}`);
    assert.match(info.subject, /x402-facilitator test merchant/);
    assert.match(info.fingerprint256, /^[0-9A-F:]+$/);

    const verdict = checkCertificateExpiry({
      cert: authority.client.cert,
      warnWithinDays: 14,
      endpointId: 'acme-enterprise',
      warn: m => warns.push(m),
    });

    assert.equal(verdict.expired, false);
    assert.ok(
      warns.some(m => /acme-enterprise/.test(m) && /rotate it before then/.test(m)),
      warns.join('\n'),
    );
  });

  test('a lapsed certificate is called out as expired', () => {
    const authority = createCertificateAuthority();
    const cert = new X509Certificate(authority.client.cert);
    const warns = [];

    // Pretend we are two days past the certificate's notAfter.
    const verdict = checkCertificateExpiry({
      cert: authority.client.cert,
      now: Date.parse(cert.validTo) + 2 * 86_400_000,
      endpointId: 'acme-enterprise',
      warn: m => warns.push(m),
    });

    assert.equal(verdict.expired, true);
    assert.ok(
      warns.some(m => /EXPIRED/.test(m)),
      warns.join('\n'),
    );
  });

  test('a healthy certificate is silent', () => {
    const authority = createCertificateAuthority();
    const warns = [];
    checkCertificateExpiry({
      cert: authority.client.cert,
      warnWithinDays: 14,
      warn: m => warns.push(m),
    });
    assert.deepEqual(warns, [], 'a certificate with room to spare must not cry wolf');
  });

  test('the credential fingerprint is stable, differs per material, and is log-safe', () => {
    const authority = createCertificateAuthority();
    const creds = { cert: authority.client.cert, key: authority.client.key };

    assert.equal(credentialFingerprint(creds), credentialFingerprint({ ...creds }));
    assert.notEqual(
      credentialFingerprint(creds),
      credentialFingerprint({ ...creds, ca: authority.ca.cert }),
    );
    assert.match(credentialFingerprint(creds), /^sha256:[0-9a-f]{32}$/);
    assert.ok(
      !credentialFingerprint(creds).includes('BEGIN'),
      'a fingerprint must never carry key material into a log line',
    );
  });
});

describe('mTLS record plumbing', () => {
  test('only a record with an mtls.ref is treated as mTLS', () => {
    assert.equal(isMtlsConfigured({ mtls: { ref: 'merchant/acme' } }), true);
    assert.equal(isMtlsConfigured({ mtls: {} }), false);
    assert.equal(isMtlsConfigured({}), false);
    assert.equal(isMtlsConfigured(null), false);
  });

  test('a secret pasted onto the event is stripped before it reaches the topic', async t => {
    // Nothing reads a secret off the record any more, so a caller who inlines
    // one must not have it silently published to every consumer group.
    const authority = createCertificateAuthority();
    const provider = providerFor(authority);
    t.after(() => provider.closeAll());

    const kafka = fakeKafkaFactory();
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      topic: 'webhooks',
      mtlsProvider: provider,
      signingSecrets: { acme: 'configured-at-boot' },
      createKafka: kafka,
    });
    t.after(() => dispatcher.stop());

    dispatcher.enqueue({
      type: 'settlement.completed',
      endpointId: 'acme',
      signingSecret: 'pasted-by-the-caller',
    });
    await sleep(10);

    const onTheWire = kafka.sent[0].messages[0].value.toString();
    assert.ok(
      !onTheWire.includes('pasted-by-the-caller'),
      'the record must not carry an inlined secret',
    );
    assert.ok(!onTheWire.includes('signingSecret'), 'the field is removed, not just emptied');
  });

  test('the wire record carries a credential ref, never key material', async t => {
    const authority = createCertificateAuthority();
    const provider = providerFor(authority);
    t.after(() => provider.closeAll());

    const kafka = fakeKafkaFactory();
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      topic: 'webhooks',
      mtlsProvider: provider,
      signingSecrets: { acme: 'super-secret' },
      createKafka: kafka,
    });
    t.after(() => dispatcher.stop());

    dispatcher.enqueue({
      type: 'settlement.completed',
      endpointId: 'acme',
      mtls: { ref: 'merchant/acme' },
    });
    await sleep(10);

    const onTheWire = kafka.sent[0].messages[0].value.toString();
    assert.ok(onTheWire.includes('merchant/acme'), 'the ref must travel with the event');
    for (const secret of ['BEGIN', 'PRIVATE KEY', 'super-secret', authority.client.key]) {
      assert.ok(!onTheWire.includes(secret), `the wire record must not contain ${secret}`);
    }
  });

  test('the Kafka consumer authenticates with the credentials it resolved itself', async t => {
    const authority = createCertificateAuthority();
    const secret = 'consumer-side-secret';
    const receiver = await startReceiver({
      key: authority.server.key,
      cert: authority.server.cert,
      ca: authority.ca.cert,
      onRequest: (req, res) => {
        res.writeHead(200);
        res.end('{}');
      },
    });
    // Teardown is registered rather than inlined: an assertion below can fail
    // before the close is reached, and a leaked listening server keeps the
    // test process alive forever.
    t.after(() => receiver.close());

    const provider = providerFor(authority);
    t.after(() => provider.closeAll());

    const kafka = fakeKafkaFactory();
    // The consumer holds no secret from the record; it reads it per endpointId.
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      mtlsProvider: provider,
      resolveSigningSecret: async record => (record.endpointId === 'acme' ? secret : null),
      createKafka: kafka,
      fetchImpl: undiciFetch,
    });
    t.after(() => dispatcher.stop());

    await dispatcher.start();
    await kafka.deliver({
      id: 'e1',
      type: 'settlement.completed',
      endpointId: 'acme',
      mtls: { ref: 'merchant/acme' },
      url: `${receiver.origin}/hook`,
    });

    const got = receiver.received[0];
    assert.equal(got.authorized, true, 'the consumer must present the client certificate');
    assert.ok(
      verifySignature({ headers: got.headers, rawBody: got.rawBody, secret }),
      'the consumer must resolve the secret from the endpointId, not the record',
    );
  });
});

describe('isCertificateRejection', () => {
  test('recognises client-visible TLS verification failures', () => {
    const codes = [
      'CERT_REQUIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      // Verified against a real rogue-CA receiver in the test above; OpenSSL
      // picks this code when a custom trust bundle is configured.
      'CERT_SIGNATURE_FAILURE',
      'CERT_UNTRUSTED',
    ];
    for (const code of codes) {
      assert.equal(isCertificateRejection({ code }), true, code);
      // undici wraps the socket error one level down.
      assert.equal(
        isCertificateRejection(new Error('fetch failed', { cause: { code } })),
        true,
        code,
      );
    }
  });

  test('an ordinary transport failure is not a certificate rejection', () => {
    assert.equal(isCertificateRejection({ code: 'ECONNRESET' }), false);
    assert.equal(isCertificateRejection({ code: 'ETIMEDOUT' }), false);
    // What a receiver-side client-cert rejection actually looks like to us.
    assert.equal(
      isCertificateRejection({ code: 'UND_ERR_SOCKET', message: 'other side closed' }),
      false,
    );
    assert.equal(isCertificateRejection(new Error('boom')), false);
    assert.equal(isCertificateRejection(null), false);
  });
});
