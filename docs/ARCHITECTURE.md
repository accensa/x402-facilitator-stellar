# Architecture

```mermaid
flowchart LR
    A[Buyer agent] -->|1. request| RS[Resource server]
    RS -->|2. 402 + terms| A
    A -->|3. PaymentPayload| RS
    RS -->|4. POST /verify, /settle| F

    subgraph F[" Facilitator "]
        HTTP["/verify · /settle · /supported"]
        BAZAAR["/discovery/search"]
        SCHEME["ExactStellarScheme"]
        HTTP --> SCHEME
    end

    SCHEME -->|5. submit auth entry| SOR[(Stellar / Soroban)]
    RS -.->|register| BAZAAR
```

## Multi-Region Failover (#126)

High-availability deployment with automatic failover across geographic regions.
Each region runs its own facilitator instance; state converges via CRDT merge
through a shared CockroachDB (or multi-region Postgres) cluster.

### Topology

```
                    ┌─────────────────────────────────────────────────┐
                    │          Global CockroachDB Cluster             │
                    │   (CRDT G-Counter merges via GREATEST(col))    │
                    └──────────────┬──────────────┬──────────────────┘
                                   │              │
                    ┌──────────────▼──┐    ┌──────▼──────────────┐
                    │  us-east-1      │    │  eu-west-1          │
                    │                 │    │                     │
                    │  ┌───────────┐  │    │  ┌───────────┐      │
                    │  │ Redis     │  │    │  │ Redis     │      │
                    │  │ (rate lim)│  │    │  │ (rate lim)│      │
                    │  └───────────┘  │    │  └───────────┘      │
                    │                 │    │                     │
                    │  ┌───────────┐  │    │  ┌───────────┐      │
                    │  │ Redlock   │  │    │  │ Redlock   │      │
                    │  │ (3 nodes) │  │    │  │ (3 nodes) │      │
                    │  └───────────┘  │    │  └───────────┘      │
                    │                 │    │                     │
                    │  FailoverHealth │    │  FailoverHealth     │
                    │  ┌───────────┐  │    │  ┌───────────┐      │
                    │  │ CRDT Store│──┼────┼──│ CRDT Store│      │
                    │  └───────────┘  │    │  └───────────┘      │
                    └─────────────────┘    └─────────────────────┘
                         ▲                          ▲
                         │    FailoverHealth        │
                         │    (periodic /healthz    │
                         │     checks between)      │
                         └──────────────────────────┘
```

### Components

**CrdtRateLimitStore** (`src/crdt-rate-limit-store.js`)

G-Counter CRDT for region-aware rate limiting. Local increments are free
(in-memory Map); periodic sync to CockroachDB merges via `GREATEST(local,
remote)`. On database failure the store degrades to local-only mode — the
service keeps operating, counters just stop converging until the DB recovers.

```
CRDT merge rule:  max(local_count, remote_count)
```

**FailoverHealthChecker** (`src/failover-health.js`)

Monitors local health and periodically checks remote regions via HTTP
`GET /healthz`. State transitions:

```
healthy  ──(N failures)──>  degraded  ──(recovery pings)──>  recovering  ──(M successes)──>  healthy
```

- **healthy**: local passes, traffic routed here
- **degraded**: local failing, orchestrator should route to preferred region
- **recovering**: local recovering, not yet ready for traffic

The checker exposes `getState()` with `preferredRegion`, `failoverActive`, and
per-remote `healthy` status, all surfaced in `GET /health/ready`.

### Failover Timing

| Metric                | Worst Case | Notes                              |
|-----------------------|------------|-------------------------------------|
| Failover detection    | 15s        | 5s interval × 3 failures            |
| Failback detection    | 10s        | 5s interval × 2 recovery pings      |
| Total failover+back   | 25s        | Under 30s acceptance criterion      |

### Split-Brain Prevention

1. **Single preferred region**: only one region has `preferredRegion` status at a time, selected by priority order among healthy regions
2. **Recovering is not healthy**: partial recovery keeps the region in `degraded` state from routing perspective
3. **CockroachDB linearizability**: GREATEST merge ensures a write from any region cannot be lost to a stale read from another

### Configuration

```bash
# Region identity for this instance
REGION=us-east-1

# All regions with priority (lower = preferred first)
REGIONS=us-east-1:1,eu-west-1:2

# Use CRDT store for rate limits (requires DATABASE_URL to CockroachDB)
RATE_LIMIT_STORE=crdt

# Shared CockroachDB (or multi-region Postgres) cluster
DATABASE_URL=postgres://user:pass@cockroachdb:26257/x402_facilitator?sslmode=verify-full
```

### Testing

```bash
# Unit + integration tests
node --test test/crdt-rate-limit-store.test.js test/failover-health.test.js test/multi-region-failover.test.js

# Multi-region Docker Compose
docker compose -f docker-compose.multi-region.yml up --build
curl http://localhost:3402/health/ready | jq .failover
```
