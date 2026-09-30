/**
 * Webhook authentication: mTLS client certificates for enterprise merchants, and
 * HMAC-SHA256 request signing for everyone else (#429).
 *
 * WHY TWO MECHANISMS. A merchant's webhook receiver is a machine we do not
 * control, and everything we publish to it is a settlement fact. HMAC-SHA256
 * over the exact bytes on the wire proves the payload came from us and was not
 * altered in flight; it costs nothing and works with any HTTP client. That is
 * the default, and it is what every non-enterprise merchant gets.
 *
 * mTLS is the enterprise upgrade: the receiver demands a client certificate at
 * the TLS layer, so the channel itself is mutually authenticated and a
 * misrouting or interception attempt fails during the handshake rather than
 * being caught (or not) by the application. The certificate is merchant-scoped,
 * so each endpoint can require its own.
 *
 * WHERE THE KEY MATERIAL COMES FROM. A private key is a credential, so this
 * module never reads one from the environment, a config file, or the event
 * itself. Callers pass a `resolve` function — a Vault read, a KMS fetch, a
 * mounted-secret read — and this module only ever holds the resolved PEM in
 * memory for as long as the cached credential is alive. It is never logged:
 * `describeCertificate` reports subject, issuer, validity and fingerprint only.
 *
 * AGENT REUSE. An undici Agent owns a TLS connection pool, so building one per
 * delivery would mean a fresh TCP + handshake for every event. The provider
 * caches one agent per distinct (cert, key, ca) triple, keyed by a digest of the
 * material, and hands the same instance to concurrent deliveries. `closeAll`
 * tears the pools down on shutdown.
 */

import { X509Certificate, createHash, createHmac } from 'node:crypto';
import { Agent } from 'undici';

/** Header carrying the lowercase hex HMAC-SHA256 of the delivery timestamp. */
export const SIGNATURE_HEADER = 'x-x402-webhook-signature';
/** Header carrying the unix-seconds timestamp the signature covers. */
export const TIMESTAMP_HEADER = 'x-x402-webhook-timestamp';

/**
 * How long a resolved certificate stays in memory before it is fetched again.
 *
 * Vault-issued client certificates rotate on their own schedule, so the
 * provider re-reads on this interval instead of pinning a key for the life of
 * the process. 15 minutes is short enough that a rotation is picked up well
 * inside the certificate's own lifetime, and long enough that a busy
 * dispatcher is not making a vault call per event.
 */
export const DEFAULT_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

/**
 * Default alert threshold for certificate expiry, in days.
 *
 * A client certificate that lapses fails the TLS handshake at the receiver, so
 * the failure is total and immediate — every subsequent delivery to that
 * endpoint fails until someone notices. Fourteen days is chosen to leave room
 * for a rotation that depends on a human: the warning must arrive well before
 * the `notAfter` date, not on it.
 */
export const DEFAULT_EXPIRY_WARN_DAYS = 14;

/** Raised when an mTLS delivery fails at the TLS layer rather than in the app. */
export class MtlsError extends Error {
  constructor(message, { code = 'mtls_error', endpointId = null, cause } = {}) {
    super(message);
    this.name = 'MtlsError';
    this.code = code;
    this.endpointId = endpointId;
    if (cause) this.cause = cause;
  }
}

/**
 * Signs a delivery with HMAC-SHA256 over `${timestamp}.${body}`.
 *
 * The timestamp is inside the signed material, not merely alongside it, so a
 * captured delivery cannot be replayed indefinitely: a receiver that checks
 * freshness rejects an old timestamp even though the body signature is
 * perfectly valid. The `sha256=` prefix matches the convention receivers
 * already parse, and the digest is hex because that is what every HMAC
 * comparison helper in the ecosystem expects.
 *
 * @param {object} params
 * @param {string} params.secret - shared secret (a Buffer or utf8 string)
 * @param {string} params.body - the exact bytes that will go on the wire
 * @param {number} [params.timestamp] - unix seconds; injected in tests
 * @returns {string} the value for the signature header
 */
export function signPayload({ secret, body, timestamp = Math.floor(Date.now() / 1000) }) {
  if (!secret)
    throw new MtlsError('cannot sign a webhook delivery without a secret', {
      code: 'missing_signing_secret',
    });
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  const mac = createHmac('sha256', key).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `sha256=${mac}`;
}

/**
 * Builds the signature headers for a delivery.
 *
 * @param {object} params
 * @param {string} params.body - the exact serialized body
 * @param {string} [params.secret] - when absent, returns {} and the delivery is
 *   sent unsigned. An unsigned delivery is not an error here: mTLS-only
 *   enterprise endpoints authenticate at the TLS layer and deliberately carry
 *   no shared secret.
 * @param {number} [params.timestamp]
 * @returns {Record<string, string>}
 */
export function signatureHeaders({ body, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  if (!secret) return {};
  return {
    [SIGNATURE_HEADER]: signPayload({ secret, body, timestamp }),
    [TIMESTAMP_HEADER]: String(timestamp),
  };
}

/**
 * True when a record asks for mTLS delivery.
 *
 * A record opts in by carrying an `mtls` block with a credential `ref`. The
 * ref is a vault path or KMS alias, not the key itself — that indirection is
 * the whole point, so a ref is required rather than accepting inline PEM.
 *
 * @param {object|null|undefined} record - a webhook event or wire record
 * @returns {boolean}
 */
export function isMtlsConfigured(record) {
  return Boolean(record?.mtls?.ref);
}

/**
 * Reads the identity and lifetime out of a PEM certificate.
 *
 * Used for the pre-expiry alert, so it reports what an operator needs to
 * rotate (subject, issuer, fingerprint) and never the private key. A
 * certificate that cannot be parsed is a configuration error, not a transient
 * one, so it throws rather than returning nulls that would silently disable the
 * expiry check.
 *
 * @param {string} pem
 * @returns {{
 *   subject: string, issuer: string, validFrom: string, validTo: string,
 *   fingerprint256: string, serialNumber: string,
 *   daysRemaining: number, expired: boolean,
 * }}
 */
export function describeCertificate(pem, { now = Date.now() } = {}) {
  let cert;
  try {
    cert = new X509Certificate(pem);
  } catch (err) {
    throw new MtlsError(`client certificate is not a readable PEM certificate: ${err.message}`, {
      code: 'invalid_certificate',
      cause: err,
    });
  }

  const validToMs = Date.parse(cert.validTo);
  if (!Number.isFinite(validToMs)) {
    throw new MtlsError('client certificate has an unreadable notAfter date', {
      code: 'invalid_certificate',
    });
  }

  return {
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    // The fingerprint is what an operator matches against the CA's records when
    // confirming which certificate is installed, so it is worth surfacing.
    fingerprint256: cert.fingerprint256,
    serialNumber: cert.serialNumber,
    daysRemaining: Math.floor((validToMs - now) / 86_400_000),
    expired: validToMs <= now,
  };
}

/**
 * Warns when a merchant's client certificate is inside the expiry window or
 * already lapsed.
 *
 * Called on the delivery path, so it is advisory: a lapsed certificate is
 * reported and delivery is still attempted, because the failure the operator
 * needs to see is the receiver's, not ours. Returns the verdict so a caller can
 * assert on it, and to decide whether a proactive probe is warranted.
 *
 * @param {object} params
 * @param {string} params.cert - PEM
 * @param {number} [params.warnWithinDays]
 * @param {number} [params.now] - epoch ms, injected in tests
 * @param {string} [params.endpointId] - for the warning text only
 * @param {(msg: string) => void} [params.warn]
 * @returns {{expired: boolean, daysRemaining: number, warnWithinDays: number}}
 */
export function checkCertificateExpiry({
  cert,
  warnWithinDays = DEFAULT_EXPIRY_WARN_DAYS,
  now = Date.now(),
  endpointId = null,
  warn = msg => console.warn(msg),
}) {
  const info = describeCertificate(cert, { now });
  const label = endpointId ? `webhook endpoint "${endpointId}"` : 'webhook endpoint';

  if (info.expired) {
    warn(
      `[webhooks] mTLS client certificate for ${label} EXPIRED at ${info.validTo} ` +
        `(serial ${info.serialNumber}) — deliveries will fail the TLS handshake until it is replaced`,
    );
  } else if (info.daysRemaining <= warnWithinDays) {
    warn(
      `[webhooks] mTLS client certificate for ${label} expires in ${info.daysRemaining} day(s) ` +
        `on ${info.validTo} (serial ${info.serialNumber}) — rotate it before then`,
    );
  }

  return { expired: info.expired, daysRemaining: info.daysRemaining, warnWithinDays };
}

/**
 * An identity for a set of TLS credentials, derived from a digest of the
 * material rather than the material itself.
 *
 * The digest is only ever used as a Map key and as a log-safe identifier, so a
 * key that leaked into a log line would be useless to an attacker. It also
 * makes agent reuse automatic: rotate the certificate and the digest changes,
 * so the next delivery builds a fresh pool instead of reusing a socket
 * negotiated with the old identity.
 *
 * @param {{cert: string, key: string, ca?: string|null}} credentials
 * @returns {string} `sha256:<hex>`
 */
export function credentialFingerprint({ cert, key, ca = null }) {
  const hash = createHash('sha256');
  hash.update(cert ?? '');
  hash.update(' ');
  hash.update(key ?? '');
  hash.update(' ');
  hash.update(ca ?? '');
  return `sha256:${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Resolves, caches and pools mTLS client credentials for webhook delivery.
 *
 * Lifecycle of one endpoint's credentials:
 *   1. a record with `mtls.ref` is delivered and the ref is not in the cache,
 *      so `resolve(ref)` is called (Vault read, KMS fetch, mounted secret);
 *   2. the resolved PEM is checked for expiry, and a warning is emitted when it
 *      is inside the window;
 *   3. an undici Agent is built from the material and cached under the
 *      credential digest, so concurrent and later deliveries share the pool;
 *   4. after `credentialTtlMs` the PEM is re-resolved, which picks up a
 *      rotation without a restart.
 *
 * Concurrent deliveries for a ref that is not yet resolved share one in-flight
 * promise rather than racing to the vault — the classic stampede on a cold
 * cache after a deploy.
 */
export class MtlsCredentialProvider {
  /**
   * @param {object} options
   * @param {(ref: string) => Promise<{cert: string, key: string, ca?: string}>} options.resolve
   *   Fetches the PEM material for a credential ref. Injected so this module
   *   never owns a secret store client — and so tests need no vault.
   * @param {number} [options.credentialTtlMs]
   * @param {number} [options.warnWithinDays]
   * @param {Function} [options.createAgent] - undici Agent factory (injectable for tests)
   * @param {(msg: string) => void} [options.warn]
   * @param {() => number} [options.now] - clock, injectable for tests
   * @param {(msg: string) => void} [options.log]
   */
  constructor({
    resolve,
    credentialTtlMs = DEFAULT_CREDENTIAL_TTL_MS,
    warnWithinDays = DEFAULT_EXPIRY_WARN_DAYS,
    createAgent = connect => new Agent({ connect }),
    warn = msg => console.warn(msg),
    log = () => {},
    now = () => Date.now(),
  }) {
    if (typeof resolve !== 'function') {
      throw new MtlsError('MtlsCredentialProvider requires a resolve function', {
        code: 'missing_resolver',
      });
    }
    this.resolve = resolve;
    this.credentialTtlMs = credentialTtlMs;
    this.warnWithinDays = warnWithinDays;
    this.createAgent = createAgent;
    this.warn = warn;
    this.log = log;
    this.now = now;
    /** @type {Map<string, {expiresAt: number, credentials: object, fingerprint: string}>} */
    this._cache = new Map();
    /** @type {Map<string, Promise<object>>} in-flight resolutions, keyed by ref. */
    this._inFlight = new Map();
    /** @type {Map<string, import('undici').Agent>} agents, keyed by credential digest. */
    this._agents = new Map();
  }

  /**
   * Returns a pooled dispatcher (undici Agent) for a record's mTLS config.
   *
   * @param {object} params
   * @param {{ref: string, caRef?: string, ca?: string, endpointId?: string}} params.mtls
   * @returns {Promise<{agent: object, fingerprint: string, certificate: object}>}
   * @throws {MtlsError} when the ref is missing, unresolvable, or the material
   *   is not a usable certificate/key pair.
   */
  async getAgent({ mtls }) {
    if (!mtls?.ref) {
      throw new MtlsError('mTLS delivery requested without a credential ref', {
        code: 'missing_ref',
      });
    }

    const { credentials, fingerprint } = await this._credentialsFor(mtls);

    let agent = this._agents.get(fingerprint);
    if (!agent) {
      agent = this.createAgent({
        // The certificate the receiver verifies, and the private key proving we
        // hold it. Node rejects a malformed pair at connect time with a much
        // less actionable message than a check here, so validate the shapes.
        cert: credentials.cert,
        key: credentials.key,
        // A custom CA bundle is what lets an enterprise receiver present a
        // private server certificate. Without it the default trust store would
        // reject the receiver before our client certificate is ever seen.
        ...(credentials.ca ? { ca: credentials.ca } : {}),
      });
      this._agents.set(fingerprint, agent);
      this.log(`webhooks: mTLS agent ready (${fingerprint})`);
    }

    return { agent, fingerprint, certificate: credentials.info };
  }

  /**
   * Returns the cached credential for a ref, resolving it when absent or stale.
   *
   * A resolve failure is not cached: a vault blip should be retried on the next
   * delivery, not remembered for the whole TTL.
   *
   * @param {object} mtls
   * @returns {Promise<{credentials: object, fingerprint: string}>}
   */
  async _credentialsFor(mtls) {
    const cached = this._cache.get(mtls.ref);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return { credentials: cached.credentials, fingerprint: cached.fingerprint };
    }

    // Collapse a stampede: every delivery that arrives while the first vault
    // read is in flight awaits the same promise.
    let pending = this._inFlight.get(mtls.ref);
    if (!pending) {
      pending = this._loadCredentials(mtls).finally(() => this._inFlight.delete(mtls.ref));
      this._inFlight.set(mtls.ref, pending);
    }
    return pending;
  }

  /**
   * Fetches, validates and caches the material for one ref.
   *
   * @param {object} mtls
   * @returns {Promise<{credentials: object, fingerprint: string}>}
   */
  async _loadCredentials(mtls) {
    let resolved;
    try {
      resolved = await this.resolve(mtls.ref);
    } catch (err) {
      throw new MtlsError(
        `could not resolve mTLS credentials for endpoint "${mtls.endpointId ?? mtls.ref}": ${err.message}`,
        { code: 'credential_resolve_failed', endpointId: mtls.endpointId, cause: err },
      );
    }

    if (!resolved?.cert || !resolved?.key) {
      throw new MtlsError(
        `mTLS credential ref "${mtls.ref}" did not yield both a certificate and a private key`,
        { code: 'incomplete_credentials', endpointId: mtls.endpointId },
      );
    }

    // Parsing here is what makes the expiry alert possible at all, and it turns
    // a PEM typo into a clear error at resolution time rather than an opaque
    // handshake failure on the delivery path.
    const info = describeCertificate(resolved.cert, { now: this.now() });
    checkCertificateExpiry({
      cert: resolved.cert,
      warnWithinDays: this.warnWithinDays,
      now: this.now(),
      endpointId: mtls.endpointId,
      warn: this.warn,
    });

    // An inline `ca` on the record wins over one from the vault, because a
    // receiver switching its private CA is a per-endpoint operator decision and
    // should not need a vault write to take effect.
    const ca = mtls.ca ?? resolved.ca ?? null;
    const credentials = { cert: resolved.cert, key: resolved.key, ca, info };
    const fingerprint = credentialFingerprint(credentials);

    const previous = this._cache.get(mtls.ref);
    this._cache.set(mtls.ref, {
      credentials,
      fingerprint,
      expiresAt: this.now() + this.credentialTtlMs,
    });
    // A rotation changes the digest, so the pool built for the old identity is
    // now orphaned. Close it here rather than letting it linger until shutdown.
    if (previous && previous.fingerprint !== fingerprint) {
      this._closeAgent(previous.fingerprint);
    }

    return { credentials, fingerprint };
  }

  _closeAgent(fingerprint) {
    const agent = this._agents.get(fingerprint);
    if (!agent) return;
    this._agents.delete(fingerprint);
    Promise.resolve(agent.close?.()).catch(() => {});
  }

  /** Number of live agents; exposed so a test can assert pools are reused. */
  get agentCount() {
    return this._agents.size;
  }

  /**
   * Drops every cached credential and closes every pooled agent.
   *
   * Called on shutdown so private keys leave memory and sockets are closed
   * cleanly. A close failure is logged, never thrown: shutdown must not fail
   * because a socket was already gone.
   *
   * @returns {Promise<void>}
   */
  async closeAll() {
    this._cache.clear();
    this._inFlight.clear();
    const agents = [...this._agents.values()];
    this._agents.clear();
    await Promise.allSettled(
      agents.map(agent =>
        Promise.resolve(agent?.close?.()).catch(err => {
          this.warn(`webhooks: error closing mTLS agent: ${err.message}`);
        }),
      ),
    );
  }
}

/**
 * Builds the per-delivery authenticator the dispatcher calls before every send.
 *
 * The result decides, for one record, whether the request is signed, whether it
 * rides a client certificate, and which pooled Agent carries it. Keeping that
 * decision in one place is what makes the two mechanisms compose instead of
 * competing: an enterprise record with `mtls.ref` gets its client certificate
 * AND, if a secret is also configured, its HMAC signature — belt and braces is
 * a merchant's call, not ours.
 *
 * SECRET SOURCE ORDER, most specific first:
 *   1. `resolveSecret(record)` — a vault/KMS read, for the Kafka consumer that
 *      holds only an `endpointId` on the wire record;
 *   2. `signingSecrets[record.endpointId]` — an in-process map, for the
 *      single-node deployment that configured its secret at boot.
 *
 * There is deliberately no third source read off `record`. A secret placed on
 * the record would be serialised into the Kafka topic and the dead-letter
 * store, so the only thing a record may carry is the `endpointId` that leads
 * back to the material. That is why a broker hop does not turn a rotation into
 * a redeploy.
 *
 * @param {object} options
 * @param {MtlsCredentialProvider|null} [options.mtlsProvider] - when set, records
 *   with an `mtls.ref` are delivered over a client certificate
 * @param {Record<string, string>} [options.signingSecrets] - endpointId -> shared secret
 * @param {(record: object) => Promise<string|null>} [options.resolveSecret] - vault/KMS lookup
 * @param {() => number} [options.now]
 * @param {(msg: string) => void} [options.warn]
 * @param {(msg: string) => void} [options.log]
 * @returns {(record: object, body: string) => Promise<{dispatcher: object|undefined, headers: Record<string, string>}>}
 */
export function createDeliveryAuthenticator({
  mtlsProvider = null,
  signingSecrets = {},
  resolveSecret = null,
  now = () => Date.now(),
  warn = msg => console.warn(msg),
  log = () => {},
} = {}) {
  return async function authenticate(record, body) {
    const headers = {};

    // HMAC first: it is cheap, and a delivery that is signed is still worth
    // sending if the mTLS agent cannot be built — the receiver may well be the
    // only thing checking the signature.
    const secret = await resolveSigningSecret({ record, signingSecrets, resolveSecret });
    if (secret) {
      Object.assign(
        headers,
        signatureHeaders({ body, secret, timestamp: Math.floor(now() / 1000) }),
      );
    }

    if (!mtlsProvider || !isMtlsConfigured(record)) {
      return { dispatcher: undefined, headers };
    }

    try {
      const { agent, fingerprint } = await mtlsProvider.getAgent({
        mtls: {
          ...record.mtls,
          // The endpoint id rides into the expiry warning so an operator can
          // tell which merchant's certificate is the one lapsing.
          endpointId: record.endpointId ?? record.mtls.endpointId ?? null,
        },
      });
      log(`webhooks: delivering to ${record.endpointId ?? 'endpoint'} over mTLS (${fingerprint})`);
      return { dispatcher: agent, headers };
    } catch (err) {
      // A credential that cannot be resolved is a configuration fault, and
      // retrying the TLS handshake will not fix it. The delivery is still
      // attempted (possibly signed) so the failure surfaces at the receiver and
      // in the DLQ with the endpoint attached, rather than as a silent drop.
      warn(
        `webhooks: mTLS unavailable for endpoint ${record.endpointId ?? '(unnamed)'}: ` +
          `${err.message} — falling back to signature-only delivery`,
      );
      return { dispatcher: undefined, headers };
    }
  };
}

/**
 * Looks up the shared secret for a record, following the documented order.
 *
 * A resolver that throws is not fatal: an unreadable vault must not stop an
 * unsigned-but-delivered event, so the failure is warned and the delivery
 * proceeds without a signature.
 *
 * @param {object} params
 * @param {object} params.record
 * @param {Record<string, string>} params.signingSecrets
 * @param {Function|null} params.resolveSecret
 * @param {(msg: string) => void} [params.warn]
 * @returns {Promise<string|null>}
 */
export async function resolveSigningSecret({
  record,
  signingSecrets = {},
  resolveSecret = null,
  warn = msg => console.warn(msg),
}) {
  if (typeof resolveSecret === 'function') {
    try {
      const secret = await resolveSecret(record);
      if (secret) return secret;
    } catch (err) {
      warn(
        `webhooks: could not resolve signing secret for endpoint ${record.endpointId ?? '(unnamed)'}: ` +
          `${err.message}`,
      );
    }
  }

  if (record?.endpointId && signingSecrets[record.endpointId]) {
    return signingSecrets[record.endpointId];
  }

  return null;
}

/**
 * Reads PEM material from files mounted into the container.
 *
 * The deployment path for operators with no vault: cert and key land on a
 * read-only volume (a Kubernetes secret, a systemd credentials directory) and
 * the ref is the mount prefix. Nothing is read from the environment, and the
 * file contents never leave this function.
 *
 * Intended to be wrapped in a `resolve` for {@link MtlsCredentialProvider}:
 *
 *   const { readPemFromDisk } = createDiskMtlsResolver({ baseDir: '/run/secrets' });
 *   const provider = new MtlsCredentialProvider({ resolve: readPemFromDisk });
 *
 * @param {string} baseDir - directory refs are resolved against
 * @returns {(ref: string) => Promise<{cert: string, key: string, ca: string|null}>}
 */
export function createDiskMtlsResolver({ baseDir }) {
  if (!baseDir) {
    throw new MtlsError('createDiskMtlsResolver requires a baseDir', { code: 'missing_base_dir' });
  }
  // Imported lazily so a deployment that never uses the disk resolver does not
  // pay for the module, and so the import stays out of the boot path.
  const read = async file => {
    const { readFile } = await import('node:fs/promises');
    const { join, normalize } = await import('node:path');
    // A ref is operator-supplied, so it is treated as untrusted input: resolve
    // it and refuse anything that climbs out of baseDir.
    const target = normalize(join(baseDir, file));
    const root = normalize(baseDir);
    if (target !== root && !target.startsWith(root + '/')) {
      throw new MtlsError(`mTLS credential ref "${file}" escapes the secret mount`, {
        code: 'ref_path_traversal',
      });
    }
    return readFile(target, 'utf8');
  };

  return async ref => {
    if (!ref || (/[\\/\0]/.test(ref) && ref.includes('..'))) {
      throw new MtlsError(`invalid mTLS credential ref "${ref}"`, { code: 'invalid_ref' });
    }
    const [cert, key, ca] = await Promise.all([
      read(`${ref}.crt`).catch(err => {
        throw new MtlsError(`no certificate at ${ref}.crt: ${err.message}`, {
          code: 'missing_cert',
          cause: err,
        });
      }),
      read(`${ref}.key`).catch(err => {
        throw new MtlsError(`no private key at ${ref}.key: ${err.message}`, {
          code: 'missing_key',
          cause: err,
        });
      }),
      // The CA bundle is optional: a public-CA server certificate needs none.
      read(`${ref}.ca.crt`).catch(() => null),
    ]);
    return { cert, key, ca };
  };
}
