-- migrations/004_settlement_events.sql
-- Event-sourced settlement state machine for full auditability (issue #130).
--
-- settlement_events is the append-only source of truth: every settlement
-- state transition is a row here and rows are never updated or deleted.
-- settlement_projections is a read model folded from that stream — written
-- only in the same statement that appends the event producing it (see
-- src/store/postgres.js) — kept for fast, index-backed reads instead of
-- replaying the full event log on every request.
--
-- This is additive: it does not touch the pre-existing `settlements` table
-- from migrations/003_settlement_store.sql. Nothing reads that table once
-- this migration's store is deployed, but it is left in place rather than
-- dropped.

CREATE TABLE IF NOT EXISTS settlement_events (
    id BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key, seq)
);

CREATE INDEX IF NOT EXISTS idx_settlement_events_key ON settlement_events(idempotency_key, seq);
CREATE INDEX IF NOT EXISTS idx_settlement_events_recorded_at ON settlement_events(recorded_at);

CREATE TABLE IF NOT EXISTS settlement_projections (
    idempotency_key TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    scheme TEXT NOT NULL,
    payer TEXT,
    pay_to TEXT,
    asset TEXT,
    amount TEXT,
    state TEXT NOT NULL CHECK (state IN ('submitted', 'settled', 'failed', 'unknown')),
    tx_hash TEXT,
    error_reason TEXT,
    error_message TEXT,
    response JSONB,
    key_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlement_projections_key_id ON settlement_projections(key_id);
CREATE INDEX IF NOT EXISTS idx_settlement_projections_state ON settlement_projections(state);
