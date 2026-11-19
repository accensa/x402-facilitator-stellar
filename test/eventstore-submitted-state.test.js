/**
 * `eventTypeForState` and the projected states (#766).
 *
 * `STATE_BY_EVENT_TYPE` maps SettlementInitiated -> 'submitted', but the reverse
 * `STATE_TO_EVENT_TYPE` omitted 'submitted', so `eventTypeForState('submitted')`
 * threw during replay/reconciliation. These tests pin the added mapping and that
 * all four projected states agree in both directions.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTLEMENT_EVENT_TYPES,
  STATE_BY_EVENT_TYPE,
  eventTypeForState,
} from '../src/eventstore/events.js';

/** Every projected state, with the event type that produces it. */
const EXPECTED_STATE_TO_EVENT_TYPE = {
  submitted: SETTLEMENT_EVENT_TYPES.INITIATED,
  settled: SETTLEMENT_EVENT_TYPES.SETTLED,
  failed: SETTLEMENT_EVENT_TYPES.FAILED,
  unknown: SETTLEMENT_EVENT_TYPES.OUTCOME_UNKNOWN,
};

describe('settlement state to event type mapping (#766)', () => {
  test("eventTypeForState('submitted') returns the initiated event type", () => {
    assert.equal(eventTypeForState('submitted'), SETTLEMENT_EVENT_TYPES.INITIATED);
    assert.equal(eventTypeForState('submitted'), 'SettlementInitiated');
  });

  test('all four projected states map to their expected event types', () => {
    for (const [state, type] of Object.entries(EXPECTED_STATE_TO_EVENT_TYPE)) {
      assert.equal(eventTypeForState(state), type, `state "${state}" mapped to the wrong type`);
    }
  });

  test('mappings stay consistent in both directions', () => {
    for (const [state, type] of Object.entries(EXPECTED_STATE_TO_EVENT_TYPE)) {
      // state -> type -> state round-trips
      assert.equal(STATE_BY_EVENT_TYPE[eventTypeForState(state)], state);
      // and every event type's projection state is reachable in reverse
      assert.equal(eventTypeForState(STATE_BY_EVENT_TYPE[type]), type);
    }

    // Reverse mapping covers exactly the four event types, no more, no less.
    assert.deepEqual(
      Object.keys(STATE_BY_EVENT_TYPE).sort(),
      Object.values(SETTLEMENT_EVENT_TYPES).sort(),
    );
    assert.deepEqual(
      Object.keys(EXPECTED_STATE_TO_EVENT_TYPE).sort(),
      Object.values(STATE_BY_EVENT_TYPE).sort(),
    );
  });

  test('event type constants are unchanged and both maps remain frozen', () => {
    assert.deepEqual(SETTLEMENT_EVENT_TYPES, {
      INITIATED: 'SettlementInitiated',
      SETTLED: 'SettlementSettled',
      FAILED: 'SettlementFailed',
      OUTCOME_UNKNOWN: 'SettlementOutcomeUnknown',
    });
    assert.equal(Object.isFrozen(SETTLEMENT_EVENT_TYPES), true);
    assert.equal(Object.isFrozen(STATE_BY_EVENT_TYPE), true);
  });

  test('an invalid state still throws the documented error', () => {
    assert.throws(
      () => eventTypeForState('reverted'),
      /No settlement event type is mapped to state "reverted"/,
    );
    assert.throws(() => eventTypeForState(undefined), /No settlement event type is mapped/);
  });
});
