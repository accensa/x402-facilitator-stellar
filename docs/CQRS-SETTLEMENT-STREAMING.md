# CQRS Read-Model Event Streaming Pipeline for Settlement Analytics

## Overview

This document describes the implementation of a CQRS (Command Query Responsibility Segregation) event streaming pipeline for settlement analytics in the x402 facilitator. The system separates read and write paths to achieve high-throughput settlement ingestion without locking transactional state tables.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Settlement Write Path                         │
│  (HTTP /settle endpoint → event store append)                    │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │ Event Store    │
              │ (append-only)  │
              └────────┬───────┘
                       │
                       │ Event Stream
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              Projection Worker (Async)                           │
│  • Polls event store for new events                              │
│  • Projects events into read model                               │
│  • Maintains checkpoint for recovery                             │
│  • Emits Prometheus metrics                                      │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │  Read Model    │
              │  (denormalized)│
              └────────┬───────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Settlement Read Path                          │
│  (Merchant history queries, analytics)                           │
│  Sub-10ms response times                                         │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. CheckpointManager (`src/settlement-cqrs.js`)

Tracks the last processed event offset to enable recovery after process restart.

**Features:**
- Persists checkpoint to `settlement_projection_checkpoint` table
- Single-row constraint ensures only one checkpoint exists
- Atomic updates with timestamp tracking

**Schema:**
```sql
CREATE TABLE settlement_projection_checkpoint (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_seq BIGINT NOT NULL DEFAULT 0,
  last_processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);
```

### 2. EventStreamReader (`src/settlement-cqrs.js`)

Reads batches of events from the event store starting from a given offset.

**Features:**
- Batch reading for efficient processing
- Tracks maximum sequence number for lag calculation
- Ordered by sequence number

**Query:**
```sql
SELECT seq, idempotency_key, event_type, event_version, payload, recorded_at
FROM settlement_events
WHERE seq > $1
ORDER BY seq ASC
LIMIT $2
```

### 3. ProjectionWriter (`src/settlement-cqrs.js`)

Writes projected settlement state to optimized read-model tables.

**Features:**
- Denormalized schema for fast queries
- Indexes optimized for merchant queries (key_id + created_at DESC)
- Idempotent writes with ON CONFLICT handling
- Sub-10ms query response times

**Schema:**
```sql
CREATE TABLE settlement_read_model (
  idempotency_key TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  network TEXT NOT NULL,
  scheme TEXT NOT NULL,
  payer TEXT,
  pay_to TEXT,
  asset TEXT,
  amount TEXT,
  state TEXT NOT NULL,
  tx_hash TEXT,
  error_reason TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_event_seq BIGINT NOT NULL
);

-- Optimized indexes for common queries
CREATE INDEX idx_settlement_read_key_id_created 
  ON settlement_read_model(key_id, created_at DESC);
CREATE INDEX idx_settlement_read_state 
  ON settlement_read_model(state, created_at DESC);
CREATE INDEX idx_settlement_read_network 
  ON settlement_read_model(network, created_at DESC);
```

### 4. ProjectionWorker (`src/settlement-cqrs.js`)

Asynchronous worker that continuously processes events and updates projections.

**Features:**
- Continuous polling with configurable interval
- Batch processing for efficiency
- Groups events by settlement (idempotency_key)
- Projects full settlement state from event history
- Updates checkpoint atomically
- Graceful shutdown with checkpoint persistence
- Error resilience (continues on individual projection errors)

**Configuration:**
- `batchSize`: Number of events to process per batch (default: 100)
- `pollInterval`: Milliseconds between polls (default: 1000)

### 5. StandaloneProjectionWorker (`src/eventstore/projection-worker.js`)

Wrapper for running the projection worker as an independent process.

**Features:**
- Graceful shutdown handlers (SIGTERM, SIGINT)
- Isolated from main HTTP service
- Can be scaled independently
- Automatic recovery on restart

## Event Processing Flow

1. **Event Batch Read**: Worker fetches next batch of events starting from checkpoint
2. **Event Grouping**: Events are grouped by `idempotency_key` (settlement ID)
3. **Historical Fetch**: For each settlement, fetch ALL events (for complete projection)
4. **Projection**: Apply `projectSettlement` fold to build current state
5. **Write**: Update read model with ON CONFLICT handling (idempotent)
6. **Checkpoint**: Update checkpoint to highest processed sequence number
7. **Metrics**: Emit Prometheus metrics for monitoring

## Handling Edge Cases

### Out-of-Order Events

Events within the same settlement may arrive out of order. The system handles this by:
1. Fetching ALL events for a settlement (not just new ones)
2. Sorting by sequence number before projection
3. Ensuring projection is always from complete, ordered history

### Duplicate Events

The system is idempotent:
- `ON CONFLICT DO UPDATE` ensures same result for duplicate projections
- Checkpoint advances only after successful projection
- Replay produces identical read model

### Recovery After Crash

1. Worker restarts and loads checkpoint from database
2. Resumes processing from last persisted offset
3. No events are lost or skipped
4. Projections are eventually consistent

**Test:**
```javascript
// Simulated crash recovery (test/settlement-cqrs.test.js)
const checkpointBeforeCrash = worker.checkpoint.getOffset();
worker.running = false; // Simulate crash

const newWorker = new ProjectionWorker(pool, metrics, options);
await newWorker.initialize();
assert.equal(newWorker.checkpoint.getOffset(), checkpointBeforeCrash);
```

## Prometheus Metrics

The system emits the following metrics for monitoring:

### `x402_projection_lag`
**Type:** Gauge  
**Description:** Number of events behind the event stream (projection lag)  
**Alert:** If lag > 1000 for > 5 minutes

### `x402_projection_events_processed_total`
**Type:** Counter  
**Description:** Total number of events processed by the projection worker  
**Usage:** Calculate throughput

### `x402_projection_batch_duration_seconds`
**Type:** Histogram  
**Description:** Duration of projection batch processing in seconds  
**Buckets:** 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10

### `x402_projection_throughput_events_per_second`
**Type:** Gauge  
**Description:** Event processing throughput (events/second)  
**Usage:** Monitor processing capacity

## Performance Characteristics

### Read Path (Queries)
- **Target:** Sub-10ms response times
- **Optimization:** Denormalized schema with covering indexes
- **Query:** `SELECT * FROM settlement_read_model WHERE key_id = $1 ORDER BY created_at DESC LIMIT 50`
- **Index:** `idx_settlement_read_key_id_created` (covering index)

### Write Path (Projection)
- **Target:** Process 100 events/batch in < 1 second
- **Batch Size:** Configurable (default: 100)
- **Poll Interval:** Configurable (default: 1000ms)
- **Throughput:** ~100-1000 events/second depending on configuration

### Recovery
- **Checkpoint Persistence:** Atomic update after each batch
- **Recovery Time:** Immediate (resumes from checkpoint)
- **Data Loss:** None (checkpoint persisted before acknowledgment)

## Testing

### Unit Tests (`test/settlement-cqrs.test.js`)

1. **CheckpointManager persists checkpoint offset**
2. **EventStreamReader reads events in batches**
3. **ProjectionWriter writes and updates projections**
4. **ProjectionWriter queries merchant history (sub-10ms)**
5. **ProjectionWriter gets state counts for analytics**
6. **ProjectionWorker processes events and updates checkpoint**
7. **ProjectionWorker recovers from simulated crash**
8. **ProjectionWorker handles out-of-order events**
9. **ProjectionWorker handles duplicate events idempotently**
10. **Projection catches up accurately after crash**
11. **Projection emits metrics for lag and throughput**
12. **Checkpoint persistence verified across restarts**

### Running Tests

```bash
# All CQRS tests
npm test -- test/settlement-cqrs.test.js

# Standalone tests (minimal dependencies)
node test/settlement-cqrs-standalone.test.js
```

## Usage

### Starting the Projection Worker

```javascript
import { createProjectionWorker } from './src/settlement-cqrs.js';
import { createMetrics } from './src/metrics.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const metrics = createMetrics();

const worker = await createProjectionWorker(pool, metrics, {
  log: console,
  batchSize: 100,
  pollInterval: 1000,
});

await worker.start();
```

### Querying the Read Model

```javascript
const writer = new ProjectionWriter(pool);

// Get merchant history
const history = await writer.queryMerchantHistory('merchant-1', {
  limit: 50,
  offset: 0,
  state: 'settled', // Optional filter
});

// Get analytics
const counts = await writer.getStateCounts('merchant-1');
// Returns: [{ state: 'settled', count: '10' }, ...]
```

## Deployment

### Standalone Process

Run projection worker as a separate process:

```bash
node src/eventstore/projection-worker-cli.js
```

### Environment Variables

- `DATABASE_URL`: PostgreSQL connection string
- `PROJECTION_BATCH_SIZE`: Events per batch (default: 100)
- `PROJECTION_POLL_INTERVAL`: Poll interval in ms (default: 1000)
- `METRICS_PORT`: Prometheus metrics endpoint port

### Scaling

The projection worker can be:
1. **Single instance**: Simple deployment, single point of failure
2. **Multi-instance with partitioning**: Partition by idempotency_key hash
3. **Multi-instance with leader election**: Use Redlock for leader election

Current implementation supports single instance with fast recovery.

## Monitoring

### Health Checks

```bash
# Check projection lag
curl http://localhost:9090/metrics | grep x402_projection_lag

# Check throughput
curl http://localhost:9090/metrics | grep x402_projection_throughput
```

### Alerts

```yaml
# Prometheus alert rules
- alert: ProjectionLagHigh
  expr: x402_projection_lag > 1000
  for: 5m
  annotations:
    summary: "Projection worker is lagging behind event stream"

- alert: ProjectionWorkerDown
  expr: up{job="projection-worker"} == 0
  for: 1m
  annotations:
    summary: "Projection worker is down"
```

## Future Enhancements

1. **Parallel Processing**: Partition by settlement ID for parallel projection
2. **Materialized Views**: Additional read models for specific query patterns
3. **Event Replay**: Tools to rebuild read model from scratch
4. **Schema Evolution**: Support for projection schema migrations
5. **Multi-Region**: Cross-region projection replication

## References

- [Event Sourcing Documentation](./EVENT-SOURCING.md)
- [Architecture Overview](./ARCHITECTURE.md)
- [Conformance Testing](./CONFORMANCE.md)
