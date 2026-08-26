-- migrations/003_settlement_store.sql
-- Durable settlement store with idempotency keys (issue #10).

CREATE TABLE IF NOT EXISTS settlements (
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlements_key_id ON settlements(key_id);
CREATE INDEX IF NOT EXISTS idx_settlements_state ON settlements(state);
