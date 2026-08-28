import crypto from 'node:crypto';
import {
  createSettlementEvent,
  eventTypeForState,
  SETTLEMENT_EVENT_TYPES,
} from '../eventstore/events.js';
import { projectSettlement } from '../eventstore/projection.js';

/**
 * In-memory, event-sourced settlement store (#10, #130).
 *
 * State is never written directly: every transition is an appended event,
 * and `get`/`listUnknown` read a projection folded over that event stream
 * (see eventstore/projection.js). This is also the process-local fallback a
 * PostgresSettlementStore degrades to, and single-instance/test runs use it
 * directly.
 */
export class MemorySettlementStore {
  constructor() {
    /** @type {Map<string, object[]>} idempotency_key -> ordered, append-only event log */
    this.events = new Map();
  }

  /**
   * Deterministically derive or read idempotency key for a request.
   * Prefers `Idempotency-Key` header; falls back to SHA-256 hash of payment transaction XDR.
   */
  deriveIdempotencyKey(req) {
    const header = req.headers?.['idempotency-key'];
    if (header && typeof header === 'string' && header.trim()) {
      return header.trim();
    }

    const txXdr = req.body?.paymentPayload?.transaction;
    if (typeof txXdr === 'string' && txXdr.trim()) {
      return 'derived:' + crypto.createHash('sha256').update(txXdr.trim()).digest('hex');
    }

    return (
      'derived:' +
      crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body?.paymentPayload ?? null))
        .digest('hex')
    );
  }

  /** Appends one event to an aggregate's stream. The only way state changes. */
  _append(idempotencyKey, type, payload) {
    const stream = this.events.get(idempotencyKey) ?? [];
    const event = {
      ...createSettlementEvent(type, { idempotency_key: idempotencyKey, ...payload }),
      seq: stream.length + 1,
      recorded_at: new Date().toISOString(),
    };
    stream.push(event);
    this.events.set(idempotencyKey, stream);
    return event;
  }

  _projection(idempotencyKey) {
    const stream = this.events.get(idempotencyKey);
    if (!stream || stream.length === 0) return null;
    return projectSettlement(stream);
  }

  async get(idempotencyKey) {
    const projection = this._projection(idempotencyKey);
    return projection ? { ...projection } : null;
  }

  async save(record) {
    this._append(record.idempotency_key, SETTLEMENT_EVENT_TYPES.INITIATED, {
      network: record.network ?? '',
      scheme: record.scheme ?? '',
      payer: record.payer ?? null,
      pay_to: record.pay_to ?? null,
      asset: record.asset ?? null,
      amount: record.amount ?? null,
      tx_hash: record.tx_hash ?? null,
      key_id: record.key_id ?? null,
    });
    return this.get(record.idempotency_key);
  }

  async updateState(idempotencyKey, state, details = {}) {
    if (!this.events.has(idempotencyKey)) return null;
    this._append(idempotencyKey, eventTypeForState(state), {
      tx_hash: details.tx_hash ?? null,
      error_reason: details.error_reason ?? null,
      error_message: details.error_message ?? null,
      response: details.response ?? null,
    });
    return this.get(idempotencyKey);
  }

  async listUnknown() {
    const results = [];
    for (const key of this.events.keys()) {
      const projection = this._projection(key);
      if (projection?.state === 'unknown') results.push(projection);
    }
    return results;
  }

  /**
   * Settlement state change + notification enqueue in one step (#123).
   *
   * The in-memory store has no transaction to share, so this performs the
   * state change and reports `atomicallyEnqueued: false`; the caller then
   * falls back to the direct webhook publish — exactly the behaviour when
   * there is no Postgres. PostgresSettlementStore overrides this with a
   * real single transaction (see src/store/postgres.js).
   *
   * @param {string} idempotencyKey
   * @param {object} details - updateState details (tx_hash, response, ...)
   * @param {object|null} event - notification event to enqueue; null = none
   * @returns {Promise<{atomicallyEnqueued: boolean, record: object|null, event: object|null}>}
   */
  async settleAndEnqueue(idempotencyKey, details, event) {
    const record = await this.updateState(idempotencyKey, 'settled', details);
    return { atomicallyEnqueued: false, record, event };
  }

  /** Full, ordered event history for one settlement — the audit trail (#130). */
  async getEventLog(idempotencyKey) {
    return (this.events.get(idempotencyKey) ?? []).map(e => ({ ...e }));
  }

  /**
   * Cross-aggregate, chronologically ordered export of every transition ever
   * recorded, for regulatory export (#130).
   */
  async exportAuditLog({ since, until, limit } = {}) {
    const all = [];
    for (const stream of this.events.values()) all.push(...stream);
    all.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.seq - b.seq);

    let filtered = all;
    if (since) filtered = filtered.filter(e => e.recorded_at >= since);
    if (until) filtered = filtered.filter(e => e.recorded_at <= until);
    if (limit) filtered = filtered.slice(0, limit);
    return filtered.map(e => ({ ...e }));
  }

  /**
   * Rebuilds the projection for one aggregate strictly from its event log.
   * In-memory reads already do this on every call; the Postgres store uses
   * the identical fold to repair its cached read model from source of truth.
   */
  async rebuildProjection(idempotencyKey) {
    return this.get(idempotencyKey);
  }
}
