/**
 * Multi-signer Stellar transaction submission engine (#412).
 *
 * Aggregates signatures from multiple co-signing entities before dispatching
 * high-value settlement transactions to the Stellar network.
 *
 * Scope: threshold co-signing over the existing signer pool, and envelope
 * assembly. The FACILITATOR_SECRETS pool and fee-bump secret already work
 * (see src/facilitator.js); only the threshold round-trip lives here.
 *
 * An envelope pins:
 *   - `threshold`: how many distinct signer signatures complete it
 *   - `requiredSigners`: optional allow-list of co-signer identities
 *   - `expiresAt`: strict deadline; expired envelopes never assemble
 *
 * Co-signer collection runs over HTTPS POST to each configured endpoint.
 * Mutual-TLS is supported by passing a pre-configured dispatcher/agent
 * through `tlsAgent` (or injecting `fetchImpl` in tests) — this module never
 * reads key material itself, only the transport the caller supplies.
 */

/** Default time an envelope stays collectable when the caller says nothing. */
export const DEFAULT_ENVELOPE_TTL_MS = 60_000;

/** Default per-endpoint timeout for a co-signer signature request. */
export const DEFAULT_COSIGNER_TIMEOUT_MS = 5_000;

function nowMs(now) {
  return typeof now === 'function' ? now() : Date.now();
}

/**
 * Builds a threshold multi-signer engine.
 *
 * @param {object} [options]
 * @param {number} [options.threshold] - default required signatures per envelope
 * @param {string[]} [options.coSignerEndpoints] - default mTLS endpoints to poll
 * @param {number} [options.expiresInMs] - default envelope TTL
 * @param {number} [options.requestTimeoutMs] - per-endpoint fetch timeout
 * @param {Function} [options.fetchImpl] - fetch-compatible function (tests)
 * @param {object} [options.tlsAgent] - mTLS agent/dispatcher passed to fetchImpl
 * @param {Function} [options.now] - clock seam (() => ms)
 */
export function createMultiSignerEngine({
  threshold = 2,
  coSignerEndpoints = [],
  expiresInMs = DEFAULT_ENVELOPE_TTL_MS,
  requestTimeoutMs = DEFAULT_COSIGNER_TIMEOUT_MS,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  tlsAgent = null,
  now = () => Date.now(),
} = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`multi-signer threshold must be a positive integer, got "${threshold}"`);
  }

  /** envelopeId -> envelope record */
  const pending = new Map();

  function assertLive(envelope) {
    if (envelope.status === 'expired' || nowMs(now) > envelope.expiresAt) {
      envelope.status = 'expired';
      throw new Error(`multi-signer envelope "${envelope.id}" expired`);
    }
    if (envelope.status === 'complete') return envelope;
    return envelope;
  }

  /**
   * Opens a pending envelope for a transaction awaiting co-signatures.
   *
   * @param {object} input
   * @param {string} input.id - caller-chosen envelope id (idempotency key)
   * @param {string} input.transactionXdr - unsigned Stellar transaction envelope (base64 XDR)
   * @param {number} [input.threshold] - overrides the engine default
   * @param {string[]} [input.requiredSigners] - allow-list of signer identities (optional)
   * @param {number} [input.expiresInMs] - overrides the engine TTL
   */
  function createEnvelope({
    id,
    transactionXdr,
    threshold: t = threshold,
    requiredSigners = null,
    expiresInMs: ttl = expiresInMs,
  }) {
    if (!id || typeof id !== 'string')
      throw new Error('multi-signer envelope requires a string id');
    if (!transactionXdr || typeof transactionXdr !== 'string') {
      throw new Error('multi-signer envelope requires transactionXdr');
    }
    if (!Number.isInteger(t) || t < 1) {
      throw new Error(`multi-signer threshold must be a positive integer, got "${t}"`);
    }
    if (
      requiredSigners !== null &&
      (!Array.isArray(requiredSigners) || requiredSigners.length === 0)
    ) {
      throw new Error('multi-signer requiredSigners must be a non-empty array or null');
    }
    if (requiredSigners && t > requiredSigners.length) {
      throw new Error(
        `multi-signer threshold ${t} exceeds ${requiredSigners.length} required signers`,
      );
    }
    const createdAt = nowMs(now);
    const envelope = {
      id,
      transactionXdr,
      threshold: t,
      requiredSigners: requiredSigners ? [...requiredSigners] : null,
      signatures: new Map(),
      createdAt,
      expiresAt: createdAt + ttl,
      status: 'pending',
    };
    pending.set(id, envelope);
    return snapshot(envelope);
  }

  function snapshot(envelope) {
    return {
      id: envelope.id,
      transactionXdr: envelope.transactionXdr,
      threshold: envelope.threshold,
      requiredSigners: envelope.requiredSigners ? [...envelope.requiredSigners] : null,
      signatures: [...envelope.signatures.entries()].map(([signer, signature]) => ({
        signer,
        signature,
      })),
      collected: envelope.signatures.size,
      complete: envelope.signatures.size >= envelope.threshold,
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
      status: envelope.status,
    };
  }

  function getEnvelope(id) {
    const envelope = pending.get(id);
    return envelope ? snapshot(envelope) : null;
  }

  function listPending() {
    purgeExpired();
    return [...pending.values()].filter(e => e.status === 'pending').map(snapshot);
  }

  /**
   * Records one co-signature. Duplicate signers do not double-count toward
   * the threshold; unknown signers are refused when an allow-list is set.
   */
  function addSignature(envelopeId, { signer, signature }) {
    const envelope = pending.get(envelopeId);
    if (!envelope) throw new Error(`unknown multi-signer envelope "${envelopeId}"`);
    assertLive(envelope);
    if (!signer || typeof signer !== 'string') throw new Error('signature requires a signer id');
    if (!signature || typeof signature !== 'string')
      throw new Error('signature requires a signature payload');
    if (envelope.requiredSigners && !envelope.requiredSigners.includes(signer)) {
      throw new Error(`signer "${signer}" is not an authorized co-signer for "${envelopeId}"`);
    }
    envelope.signatures.set(signer, signature);
    if (envelope.signatures.size >= envelope.threshold) envelope.status = 'complete';
    return snapshot(envelope);
  }

  function isComplete(envelopeId) {
    const envelope = pending.get(envelopeId);
    if (!envelope) return false;
    if (envelope.status === 'expired' || nowMs(now) > envelope.expiresAt) {
      envelope.status = 'expired';
      return false;
    }
    return envelope.signatures.size >= envelope.threshold;
  }

  /**
   * Asks every co-signer endpoint to sign the envelope's transaction.
   *
   * Each endpoint receives `{ envelopeId, transactionXdr }` as JSON and is
   * expected to reply `{ signer, signature }`. Endpoints run concurrently;
   * one slow or failing endpoint never blocks the others. Returns per-endpoint
   * results so the caller can distinguish "threshold reached despite one
   * failure" from "still short".
   *
   * @param {string} envelopeId
   * @param {object} [overrides]
   * @param {string[]} [overrides.endpoints]
   */
  async function requestSignatures(envelopeId, { endpoints = coSignerEndpoints } = {}) {
    const envelope = pending.get(envelopeId);
    if (!envelope) throw new Error(`unknown multi-signer envelope "${envelopeId}"`);
    assertLive(envelope);
    if (!fetchImpl) throw new Error('no fetch implementation available for co-signer requests');

    const results = await Promise.all(
      endpoints.map(async endpoint => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              envelopeId,
              transactionXdr: envelope.transactionXdr,
            }),
            signal: controller.signal,
            ...(tlsAgent ? { dispatcher: tlsAgent, agent: tlsAgent } : {}),
          });
          if (!res.ok) return { endpoint, ok: false, error: `co-signer HTTP ${res.status}` };
          const body = await res.json();
          if (!body?.signer || !body?.signature) {
            return { endpoint, ok: false, error: 'co-signer reply missing signer/signature' };
          }
          const updated = addSignature(envelopeId, {
            signer: body.signer,
            signature: body.signature,
          });
          return { endpoint, ok: true, signer: body.signer, collected: updated.collected };
        } catch (err) {
          return { endpoint, ok: false, error: err.message };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return results;
  }

  /**
   * Assembles the completed Stellar transaction envelope.
   *
   * Returns the original transaction XDR with every collected signature
   * attached in signer order — the shape the submission call site hands to
   * the network. Throws while the threshold is unmet or the deadline passed.
   */
  function assembleEnvelope(envelopeId) {
    const envelope = pending.get(envelopeId);
    if (!envelope) throw new Error(`unknown multi-signer envelope "${envelopeId}"`);
    assertLive(envelope);
    if (envelope.signatures.size < envelope.threshold) {
      throw new Error(
        `multi-signer envelope "${envelopeId}" has ${envelope.signatures.size}/${envelope.threshold} signatures`,
      );
    }
    envelope.status = 'complete';
    const signatures = [...envelope.signatures.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([signer, signature]) => ({ signer, signature }));
    return {
      envelopeId: envelope.id,
      transactionXdr: envelope.transactionXdr,
      threshold: envelope.threshold,
      signatures,
    };
  }

  /** Marks every past-deadline pending envelope expired; returns how many flipped. */
  function purgeExpired() {
    const t = nowMs(now);
    let purged = 0;
    for (const envelope of pending.values()) {
      if (envelope.status === 'pending' && t > envelope.expiresAt) {
        envelope.status = 'expired';
        purged += 1;
      }
    }
    return purged;
  }

  return {
    createEnvelope,
    addSignature,
    requestSignatures,
    assembleEnvelope,
    getEnvelope,
    listPending,
    isComplete,
    purgeExpired,
  };
}

export default createMultiSignerEngine;
