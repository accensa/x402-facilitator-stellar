import crypto from 'node:crypto';

/**
 * In-memory settlement store fallback for single-instance or test runs (#10).
 */
export class MemorySettlementStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.records = new Map();
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

  async get(idempotencyKey) {
    const rec = this.records.get(idempotencyKey);
    return rec ? { ...rec } : null;
  }

  async save(record) {
    const now = new Date().toISOString();
    const existing = this.records.get(record.idempotency_key);
    const entry = {
      idempotency_key: record.idempotency_key,
      network: record.network ?? '',
      scheme: record.scheme ?? '',
      payer: record.payer ?? null,
      pay_to: record.pay_to ?? null,
      asset: record.asset ?? null,
      amount: record.amount ?? null,
      state: record.state ?? 'submitted',
      tx_hash: record.tx_hash ?? null,
      error_reason: record.error_reason ?? null,
      error_message: record.error_message ?? null,
      response: record.response ?? null,
      key_id: record.key_id ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.records.set(record.idempotency_key, entry);
    return { ...entry };
  }

  async updateState(idempotencyKey, state, details = {}) {
    const existing = this.records.get(idempotencyKey);
    if (!existing) return null;

    const updated = {
      ...existing,
      state,
      tx_hash: details.tx_hash ?? existing.tx_hash,
      error_reason: details.error_reason ?? existing.error_reason,
      error_message: details.error_message ?? existing.error_message,
      response: details.response ?? existing.response,
      updated_at: new Date().toISOString(),
    };
    this.records.set(idempotencyKey, updated);
    return { ...updated };
  }

  async listUnknown() {
    const results = [];
    for (const rec of this.records.values()) {
      if (rec.state === 'unknown') {
        results.push({ ...rec });
      }
    }
    return results;
  }

  /**
   * Settlement state change + notification enqueue in one step (#123).
   *
   * The in-memory store has no transaction to share, so this performs the
   * state change and reports `atomicallyEnqueued: false`; the caller then
   * falls back to the direct webhook publish — exactly today's behaviour
   * when there is no Postgres. PostgresSettlementStore overrides this with
   * a real single transaction (see src/store/postgres.js).
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
}
