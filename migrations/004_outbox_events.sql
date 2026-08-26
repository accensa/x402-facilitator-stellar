-- migrations/004_outbox_events.sql
-- Transactional outbox for guaranteed delivery of settlement notifications (#123).
--
-- The settle request path writes the settlement state change and the
-- notification into ONE database transaction. If the process crashes after
-- the transaction commits but before the broker accepts the message, the
-- event is still here — a background worker polls this table and publishes,
-- so a notification survives a crash at any point. At-least-once semantics:
-- a crash between publish and the published-markup re-publishes (duplicates
-- are possible, loss is not).

CREATE TABLE IF NOT EXISTS outbox_events (
    id BIGSERIAL PRIMARY KEY,
    -- Caller-chosen idempotency key; the same event cannot be inserted twice.
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'published', 'failed')),
    -- Number of failed publish attempts so far (0 = never failed).
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    -- When a worker claimed the row; stale claims (worker died mid-publish)
    -- are re-claimed by the lease logic in src/outbox/worker.js.
    claimed_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The worker's poll query filters on this every cycle.
CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
    ON outbox_events(status, created_at)
    WHERE status IN ('pending', 'claimed');
