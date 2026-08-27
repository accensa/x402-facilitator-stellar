/**
 * Event schema for the settlement state machine (#130).
 *
 * A settlement is never mutated in place. It is a stream of these events,
 * appended in order; the current state is a projection over that stream
 * (see projection.js). Every event carries its own `event_version` so a
 * future breaking change to a payload shape can be introduced without
 * invalidating history already on disk — `projectSettlement` branches on
 * version, it never assumes the latest shape.
 */

export const SETTLEMENT_EVENT_TYPES = Object.freeze({
  INITIATED: 'SettlementInitiated',
  SETTLED: 'SettlementSettled',
  FAILED: 'SettlementFailed',
  OUTCOME_UNKNOWN: 'SettlementOutcomeUnknown',
});

/** Current schema version for every event type below. Bump per-type when a payload shape changes. */
const CURRENT_VERSION = Object.freeze({
  [SETTLEMENT_EVENT_TYPES.INITIATED]: 1,
  [SETTLEMENT_EVENT_TYPES.SETTLED]: 1,
  [SETTLEMENT_EVENT_TYPES.FAILED]: 1,
  [SETTLEMENT_EVENT_TYPES.OUTCOME_UNKNOWN]: 1,
});

/** Fields a v1 payload must carry for the event to be meaningful. */
const REQUIRED_FIELDS_V1 = Object.freeze({
  [SETTLEMENT_EVENT_TYPES.INITIATED]: ['idempotency_key', 'network', 'scheme'],
  [SETTLEMENT_EVENT_TYPES.SETTLED]: ['idempotency_key'],
  [SETTLEMENT_EVENT_TYPES.FAILED]: ['idempotency_key'],
  [SETTLEMENT_EVENT_TYPES.OUTCOME_UNKNOWN]: ['idempotency_key'],
});

/** The state a projection moves to when it applies each event type (#130). */
const STATE_BY_EVENT_TYPE = Object.freeze({
  [SETTLEMENT_EVENT_TYPES.INITIATED]: 'submitted',
  [SETTLEMENT_EVENT_TYPES.SETTLED]: 'settled',
  [SETTLEMENT_EVENT_TYPES.FAILED]: 'failed',
  [SETTLEMENT_EVENT_TYPES.OUTCOME_UNKNOWN]: 'unknown',
});

const STATE_TO_EVENT_TYPE = Object.freeze({
  settled: SETTLEMENT_EVENT_TYPES.SETTLED,
  failed: SETTLEMENT_EVENT_TYPES.FAILED,
  unknown: SETTLEMENT_EVENT_TYPES.OUTCOME_UNKNOWN,
});

/**
 * Builds a schema-checked event envelope. Throws on an unknown type or a
 * payload missing a field that type's current version requires — the store
 * layer must never be able to append something the projection can't fold.
 *
 * @param {string} type - one of SETTLEMENT_EVENT_TYPES
 * @param {object} payload
 * @returns {{event_type: string, event_version: number, payload: object}}
 */
export function createSettlementEvent(type, payload = {}) {
  const version = CURRENT_VERSION[type];
  if (!version) {
    throw new Error(`Unknown settlement event type: ${type}`);
  }
  for (const field of REQUIRED_FIELDS_V1[type]) {
    if (payload[field] === undefined || payload[field] === null) {
      throw new Error(`${type} event requires field "${field}"`);
    }
  }
  return { event_type: type, event_version: version, payload };
}

/** Maps a projected `state` string back to the event type that produces it (for updateState()). */
export function eventTypeForState(state) {
  const type = STATE_TO_EVENT_TYPE[state];
  if (!type) {
    throw new Error(`No settlement event type is mapped to state "${state}"`);
  }
  return type;
}

export { STATE_BY_EVENT_TYPE };
