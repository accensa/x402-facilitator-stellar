# Event-Sourced Settlement State Machine (#130)

## Problem

Before this change, a settlement record (`settlements` table, migrations/003)
was overwritten in place: `save()` inserted it, `updateState()` ran an
`UPDATE ... SET state = $2, ...`. Each write destroyed the row it replaced.
Reconstructing *how* a settlement reached `failed` — was it submitted once and
timed out, or retried three times against a flapping RPC endpoint before the
final rejection? — was impossible, because only the final state survived.
That is a problem the moment a settlement is disputed or a regulator asks for
the sequence of transitions, not just the outcome.

This is distinct from [`docs/AUDIT.md`](AUDIT.md)'s audit trail (`src/audit.js`),
which logs one JSON line per HTTP-level action to a side channel. That log can
be shipped, rotated, or dropped independently of the database — it is
evidence *about* the request, not the record a client's `GET
/settlements/:idempotencyKey` reads. The state machine itself needed to become
the source of truth for its own history.

## Design

### Events are the only way state changes

Every settlement is a stream of append-only events (`src/eventstore/events.js`):

| Event | Recorded when |
|---|---|
| `SettlementInitiated` | A `/settle` request is first seen for an idempotency key, or a retryable failure (`rate_limited`, `soroban_rpc_unreachable`, `lock_timeout`, `request_timeout`, …) is retried under the same key |
| `SettlementSettled` | The scheme's `settle()` call reports success |
| `SettlementFailed` | The scheme's `settle()` call reports failure, or an unrecoverable error is caught |
| `SettlementOutcomeUnknown` | The request timed out after the transaction was already submitted — success or failure cannot be determined without asking the chain |

Each event carries `event_version` (currently `1` for all four types). A
future breaking change to a payload's shape bumps that type's version;
`projectSettlement` branches on it, so old events already on disk keep folding
correctly rather than being invalidated by a schema change.

`createSettlementEvent()` rejects an unknown type or a payload missing a
field its version requires — an event that cannot be folded can never be
appended.

### Projections are derived, never authoritative

`src/eventstore/projection.js` exports one pure function, `projectSettlement(events)`,
that folds an ordered event stream into the shape the rest of the service
already expected (`state`, `tx_hash`, `error_reason`, …). It is the single
definition of "what does this settlement look like now" — every read path
uses it, directly or indirectly:

- **`MemorySettlementStore`** (`src/store/memory.js`) keeps only the event
  log (`Map<idempotency_key, event[]>`) and calls `projectSettlement` on every
  read. There is no separate mutable record to drift from the log — reading
  *is* replaying.
- **`PostgresSettlementStore`** (`src/store/postgres.js`) keeps a
  `settlement_projections` read model so a read is an indexed `SELECT`, not a
  full replay on every request. That table is written only inside the same
  statement that appends the event producing the new row — a single CTE
  (`INSERT INTO settlement_events ... RETURNING ...` feeding an
  `INSERT ... ON CONFLICT DO UPDATE` / `UPDATE ... FROM`) — so there is no
  window where an event exists without its projection or vice versa.
- **`rebuildProjection(idempotencyKey)`** replays a stream through the exact
  same `projectSettlement` fold and overwrites the cached row. It is not on
  the hot write path; it exists to repair or verify a read model against the
  event log, and it is what proves the projection is reconstructible rather
  than merely consistent by convention. `test/settlement-events.test.js`
  exercises this by deleting a projection row out from under a live store and
  confirming `rebuildProjection` reproduces it.

### Public interface is unchanged

`get`, `save`, `updateState`, `listUnknown` and `deriveIdempotencyKey` keep
their existing signatures and behaviour — `src/app.js`'s `/settle` and
`GET /settlements/:idempotencyKey` routes did not change. Internally, `save()`
now appends `SettlementInitiated` and `updateState()` appends the terminal
event matching the requested state; nothing calls a raw setter.

Two capabilities are new:

- `getEventLog(idempotencyKey)` — the full ordered history for one settlement.
- `exportAuditLog({ since, until, limit })` — every transition ever recorded,
  across all settlements, in chronological order.

`GET /settlements/:idempotencyKey/events` exposes the first of these over
HTTP, scoped to the caller's `keyId` exactly like the existing state endpoint.

### What a retry looks like

A `/settle` retry against a `failed` settlement whose `error_reason` is
retryable (see `src/app.js`) calls `save()` again on the same idempotency key.
That appends a second `SettlementInitiated` event rather than resetting the
first one — the failed attempt stays in the log. `created_at` on the
projection is the *first* event's timestamp; `updated_at` moves with each new
event. `test/settlement-events.test.js` pins this for both stores.

## Migration

`migrations/004_settlement_events.sql` adds `settlement_events` (append-only,
`UNIQUE (idempotency_key, seq)`) and `settlement_projections` (the read
model, primary-keyed on `idempotency_key`). It does not touch or drop the
`settlements` table from migrations/003 — nothing reads that table once this
store is deployed, but a non-destructive migration leaves it in place rather
than assuming no other consumer depends on it.

## Acceptance criteria

- [x] Event schemas are strictly defined and versioned — `src/eventstore/events.js`.
- [x] State mutations only occur by appending events — both stores' `save`/`updateState`
      insert an event before any projection write; `updateState` on an aggregate
      with no prior event appends nothing and returns `null`.
- [x] Projections successfully build current state from event history — `projectSettlement`,
      and `rebuildProjection` demonstrably reconstructs a deleted read-model row.
- [x] Full audit log of all transitions can be exported — `exportAuditLog()` and
      `GET /settlements/:idempotencyKey/events`.
