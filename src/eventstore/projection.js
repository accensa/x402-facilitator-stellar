/**
 * Projection engine for the settlement event stream (#130).
 *
 * `projectSettlement` is the single, pure definition of "what does this
 * settlement currently look like" — every read path (in-memory store,
 * Postgres-backed store, and its repair/rebuild path) folds the same way
 * through this function. Nothing else may derive settlement state; if a
 * store's read model disagrees with this fold, the read model is wrong.
 */
import { SETTLEMENT_EVENT_TYPES, STATE_BY_EVENT_TYPE } from './events.js';

/**
 * Folds one event onto the previous projection (or none, for the first event).
 * Unknown event types and versions are skipped rather than thrown on, so a
 * projector reading a stream written by a newer version of this service
 * degrades gracefully instead of crashing a read.
 */
function applyEvent(projection, event) {
  const { event_type: type, payload = {}, recorded_at: recordedAt } = event;
  const state = STATE_BY_EVENT_TYPE[type];
  if (!state) return projection;

  if (type === SETTLEMENT_EVENT_TYPES.INITIATED) {
    return {
      idempotency_key: payload.idempotency_key,
      network: payload.network ?? '',
      scheme: payload.scheme ?? '',
      payer: payload.payer ?? null,
      pay_to: payload.pay_to ?? null,
      asset: payload.asset ?? null,
      amount: payload.amount ?? null,
      state,
      tx_hash: payload.tx_hash ?? null,
      error_reason: null,
      error_message: null,
      response: null,
      key_id: payload.key_id ?? null,
      // A retry re-appends Initiated on an existing aggregate (see store/memory.js);
      // the first-ever event's timestamp is the creation time, not the retry's.
      created_at: projection?.created_at ?? recordedAt,
      updated_at: recordedAt,
    };
  }

  // A terminal event with no prior Initiated event is a partial/corrupt
  // history; tolerate it by seeding a minimal aggregate rather than throwing,
  // so a single bad stream can't take down an audit-log export.
  const base = projection ?? {
    idempotency_key: payload.idempotency_key ?? null,
    network: '',
    scheme: '',
    payer: null,
    pay_to: null,
    asset: null,
    amount: null,
    state: 'submitted',
    tx_hash: null,
    error_reason: null,
    error_message: null,
    response: null,
    key_id: null,
    created_at: recordedAt,
    updated_at: recordedAt,
  };

  return {
    ...base,
    state,
    tx_hash: payload.tx_hash ?? base.tx_hash,
    error_reason: payload.error_reason ?? base.error_reason,
    error_message: payload.error_message ?? base.error_message,
    response: payload.response ?? base.response,
    updated_at: recordedAt,
  };
}

/**
 * Reduces an ordered event stream (oldest first) into the current settlement
 * projection, or `null` for an empty stream.
 *
 * @param {Array<{event_type: string, event_version: number, payload: object, recorded_at: string}>} events
 * @returns {object|null}
 */
export function projectSettlement(events) {
  let projection = null;
  for (const event of events) {
    projection = applyEvent(projection, event);
  }
  return projection;
}
