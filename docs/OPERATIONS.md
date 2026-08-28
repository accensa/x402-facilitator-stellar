# Operations & Rate Limiting

The x402 facilitator includes a sliding-window rate limiter and usage meter. This protects the service from abuse and limits the cumulative fee exposure, as the service sponsors Stellar transaction fees for every settlement.

## Health Endpoints

Two endpoints, two different questions — keep them straight:

### `GET /healthz` — liveness

Always returns `200 { ok: true }` while the process runs. It performs **no
dependency checks**, deliberately: a liveness probe that fails on a downstream
outage triggers restart loops that make the outage worse (and a restart cannot
fix someone else's RPC). The Docker `HEALTHCHECK` targets this endpoint.

### `GET /readyz` — readiness

Returns `200 { status: "ready", ... }` when the instance can settle right now,
or `503 { ok: false, status: "not_ready", networks: {...} }` naming which check
failed for which network. Per configured network it checks:

| Check | Meaning of failure |
|---|---|
| `rpc_reachable` | The network's Soroban RPC did not answer a bounded getHealth call. Every `/settle` will currently fail; stop routing traffic here. |
| `signer_funded` | The facilitator signer account does not exist or is below `READINESS_FUNDING_FLOOR_STROOPS`. No settlement can be sponsored. Fund the account or fix the signer config. |

The response also reports, without ever failing on them:
- `breakers` — per-RPC-host circuit-breaker state (`open` means calls are being refused fast; see #105);
- `catalog` — catalogue-store health. A cataloguing failure must never fail a payment, so it never fails readiness either.

Results are cached for `READINESS_CACHE_TTL_MS` (default 5s) so probes do not
become an RPC burst, and every underlying call runs under its own
`READINESS_TIMEOUT_MS` (default 3s) rather than inheriting the payment path's
~12s retry budget.

**Probe wiring rule:** restart logic → `/healthz`; traffic gating (load
balancers, Kubernetes `readinessProbe`) → `/readyz`.

## Rate Limit Store

Counters live in process memory by default (`RATE_LIMIT_STORE` unset). For
multi-replica deployments set `RATE_LIMIT_STORE=postgres` with `DATABASE_URL`
so all replicas share one combined limit and the daily fee ceiling survives
restarts — see docs/DEPLOYMENT.md ("Shared Rate-Limit State").

## Configuration

Rate limits are configured via environment variables. There is a global default, and you can apply overrides per API key. 

Limits are expressed as comma-separated `key=value` pairs.

### Global Default

The `RATE_LIMIT_GLOBAL` environment variable sets the fallback limit for any authenticated caller that lacks a specific override, as well as the per-IP limit for open mode.

**Available metrics:**
- `verify_rpm`: Requests per minute for `/verify`
- `settle_rpm`: Settlements per minute
- `settle_rph`: Settlements per hour
- `settle_rpd`: Settlements per day
- `fee_spd`: Cumulative sponsored fee per day (in stroops)

**Example:**
`RATE_LIMIT_GLOBAL="verify_rpm=100,settle_rpm=10,settle_rph=100,settle_rpd=1000,fee_spd=5000000"`

If not specified, the system defaults to conservative thresholds (`verify_rpm=60,settle_rpm=10,settle_rph=100,settle_rpd=1000,fee_spd=5000000`).

### Per-Key Overrides

To grant a specific API key custom limits, set an environment variable named `RATE_LIMIT_<keyId>`.

**Example:**
If `FACILITATOR_API_KEYS=admin:secret1`, you can override limits for `admin` by setting:
`RATE_LIMIT_admin="verify_rpm=500,settle_rpm=50,fee_spd=10000000"`
Any metrics not explicitly overridden fall back to the global configuration.

## HTTP Headers

When a rate limit is exceeded, the server responds with HTTP `429 Too Many Requests`. 
The response body will contain `{ "error": "rate_limited", "reason": "rate_limit_exceeded" }` or `{ "reason": "fee_ceiling_exceeded" }`.

The following headers are included on rate-limited responses to help clients back off:
- `RateLimit-Limit`: The threshold that was exceeded
- `RateLimit-Remaining`: `0`
- `RateLimit-Reset`: Unix timestamp when the window resets
- `Retry-After`: Seconds to wait before retrying

## Usage Metering

An authenticated caller can view their own consumption by calling `GET /usage`. 
The endpoint requires a valid API key and is scoped exclusively to the caller's `keyId`.

Example Response:
```json
{
  "verify_rpm": 42,
  "settle_rpm": 5,
  "settle_rph": 12,
  "settle_rpd": 12,
  "fee_spd": 60000
}
```

## Open Mode Limits

If `FACILITATOR_API_KEYS` is omitted, the service runs in open mode. In this mode, limits from `RATE_LIMIT_GLOBAL` are enforced per source IP address rather than per API key. This prevents a single abusive client from draining a testnet faucet while still keeping onboarding frictionless.

## Observability

The transport emits **one structured JSON line per request** to stdout (one object per line, no framework). The shape is fixed and whitelisted — it never contains the auth entry, the raw `payload.transaction`, API keys, or the facilitator secret:

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 timestamp |
| `level` | `info` or `error` (derived from outcome) |
| `event` | always `"request"` |
| `requestId` | inbound `X-Request-Id`, or a generated `crypto.randomUUID()` echoed on the response |
| `route` | matched route, e.g. `/verify` |
| `network` | CAIP-2 network from the request body |
| `scheme` | scheme from the request body |
| `keyId` | caller API key id (from #5), or `null` in open mode |
| `durationMs` | request duration |
| `outcome` | `ok` \| `rejected` \| `error` |
| `reason` | reason code (from #6); `none` when there is nothing to report |
| `txHash` | settlement transaction hash, or `null` |

`LOG_LEVEL` (default `info`) filters at the line level; `debug` is not currently noisier than `info` because the structured line is the only diagnostic stream.

### Correlation

A resource server debugging a failed payment hands us a single `X-Request-Id` rather than a timestamp range. We honour an inbound one and always echo ours on the response header `X-Request-Id`.

### Metrics (`GET /metrics`)

Prometheus text format, unauthenticated. By default it is served on `PORT`; set `METRICS_PORT` to bind it to a separate listener (typically an internal interface) so it is not on the public surface. Series:

| Metric | Type | Labels | What it tells you | Alert |
|---|---|---|---|---|
| `x402_requests_total` | counter | `route`, `network`, `outcome`, `reason` | every request, by result | page if `outcome="error"` rate spikes (a dependency or code bug); investigate `reason` labels |
| `x402_request_duration_seconds` | histogram | `route`, `network` | verify/settle latency — the interactive-agent target | alert if p95 > 2s on `/verify` or `/settle` (SLO breach for agent use) |
| `x402_settlements_total` | counter | `network`, `outcome` (`settled`/`failed`) | settlement success rate | alert if `outcome="failed"` rate > 1% over 10m |
| `x402_settlement_fee_stroops` | histogram | `network` | **actual fee paid** — the number that shows whether `MAX_TX_FEE_STROOPS` is sane | alert if p95 fee approaches `MAX_TX_FEE_STROOPS` (fee ceiling about to throttle settlements) |
| `x402_rpc_retries_total` | counter | `code` | Soroban RPC connection-level retries | alert if rate > 0 for a host over several minutes (RPC degradation / IPv6 dead-ends) |
| `x402_signer_inflight` | gauge | `network`, `signer` | in-flight settlements per signer — **the sequence-contention signal (#9)** | alert if it sits at ≥ 1 persistently or climbs (signer pool needed before bursty traffic) |

Operational endpoints (`/metrics`, `/healthz`, `/health/ready`) are logged but excluded from `x402_requests_total` so the payment counters stay semantically about payments.

## Multi-Signer Pool Management (#9)

Agent payment traffic is naturally bursty. When multiple settlement requests arrive concurrently, submitting them using a single Stellar account causes sequence-number contention and transaction serialization. To achieve higher throughput, configure a multi-signer pool.

### Sizing the Pool

Calculate the required pool size using expected throughput and observed settlement latency:

$$ \text{Pool Size} = \lceil \text{Expected Settlements/sec} \times \text{Average Settlement Latency (sec)} \rceil $$

For example, if you target **20 settlements/sec** and average on-chain settlement latency is **5 seconds**, you require a pool of at least **100 signers** ($20 \times 5 = 100$).

### Configuration

Configure a comma-separated list of Stellar secret keys in `FACILITATOR_SECRETS` (for testnet) or `FACILITATOR_SECRETS_PUBNET` (for pubnet):

```env
FACILITATOR_SECRETS=S1...,S2...,S3...
```

For backward compatibility, single-signer deployments using `FACILITATOR_SECRET` remain supported.

### Fee-Bump Signer & Operational Tradeoffs

You can optionally configure `FEE_BUMP_SECRET` (or `FEE_BUMP_SECRET_PUBNET`). When configured, settlements are wrapped in a fee-bump transaction sponsored by the fee-bump account.

**Operational Tradeoff:**
- **Pros:** Decouples fee payment from sequence-number management across pool signers. Only the fee-bump account needs to hold XLM for transaction fees, simplifying funding and monitoring.
- **Cons:** Concentrates fee payment on a single account, making that fee-bump account a single point of failure if its XLM balance is depleted.

### Signer Funding

Every account in the pool (and the optional fee-bump account) must exist on-chain and be funded above `READINESS_FUNDING_FLOOR_STROOPS`. `GET /readyz` checks funding for all pool signers and reports 503 if any signer is underfunded.

### Stuck-Signer Detection & Observability

`x402-facilitator-stellar` exposes Prometheus metrics at `GET /metrics`:
- `x402_signer_selected_total{network="...", signer="..."}`: Counter tracking how many times each signer has been selected.
- `x402_signer_inflight{network="...", signer="..."}`: Gauge tracking active in-flight settlements per signer.

**Detecting Stuck Signers:**
If a specific signer's `x402_signer_selected_total` counter stops incrementing while other signers continue to advance, or if `x402_signer_inflight` remains non-zero for longer than maximum settlement latency, that signer's account sequence number may be stuck or desynchronized on the RPC node.

### Adding Signers

To add a new signer to the pool, generate and fund a new Stellar account, append its secret key to `FACILITATOR_SECRETS`, and restart the facilitator process. Boot validation ensures that malformed or duplicate secret keys are rejected before accepting traffic.

## Monitoring

### What is observed

| Source | What it answers | Notes |
| --- | --- | --- |
| `GET /healthz` | liveness | Always `{ ok: true }` while the process runs; wire it to restart logic only. |
| `GET /readyz` | readiness | Per-network RPC reachability and signer funding; names the failing check. Wire to traffic gating. |
| `GET /metrics` | Prometheus text | Settlement/verification counters, signer selection and in-flight gauges, circuit-breaker state. |
| Audit log | who did what | Settlements (with tx hash), auth failures, rate-limit rejections, catalog writes — one JSON line per event (`AUDIT_LOG_FILE` to mirror to a file). |
| Request log | one redacted line per request | Headers redacted; the body is never logged. |

### What to alert on

| Alert | Signal | Runbook step |
| --- | --- | --- |
| Instance not ready | `/readyz` 503 | [RPC outage](#runbook-responding-to-an-rpc-outage) / [signer underfunded](#runbook-settlement-starting-to-fail) |
| RPC unreachable | `soroban_rpc_unreachable` reason codes, breaker open | [RPC outage](#runbook-responding-to-an-rpc-outage) |
| Signer balance low | readiness `signer_funded` failing | [Settlement starting to fail](#runbook-settlement-starting-to-fail) |
| Stuck signer | `x402_signer_inflight` non-zero past max latency; selection counter stalled | [Stuck signer](#stuck-signer) |
| Fee ceiling near cap | `fee_spd` approaching the limit | [Settlement starting to fail](#runbook-settlement-starting-to-fail) |

### The uptime evidence

The RFP asks for a 99%+ availability target evidenced, not asserted. This repo makes
**no availability claim today**: no instance is operated, so there is nothing to
measure, and self-reported uptime from the service itself is exactly the kind of
evidence that does not count. External probes (liveness, readiness, a synthetic
testnet payment, signer balance) with a named alert owner and a public status page are
the deliverable, tracked in
[#19](https://github.com/accensa/x402-facilitator-stellar/issues/19) — this section is
the monitoring contract that issue will implement, not a claim that it exists yet.

## Runbook

### Runbook: deploying

1. Build and tag the image by digest; push to your registry.
2. Apply migrations before the process binds the port
   (`psql "$DATABASE_URL" -f migrations/001_bazaar_catalog.sql`, then
   `002_idempotency_keys.sql`).
3. Start; gate traffic on `GET /readyz` going 200.
4. Smoke-test with a real payment (the buyer guide's script in
   [`docs/BUYER.md`](./BUYER.md) is a ready-made smoke test).

### Runbook: upgrading

1. Check `docs/CONFORMANCE.md` and the diff of `package.json` for wire-format changes
   before upgrading — a bump of `@x402/*` can change response shapes.
2. Rolling restart; both old and new must serve `/verify` during cutover.
3. If a migration shipped, verify the previous image can still read the new schema
   before finishing the roll.

### Runbook: rotating keys

1. Generate a new keypair, fund it, append it to `FACILITATOR_SECRETS` (pool mode)
   alongside the old one; restart; confirm `/readyz` passes and a settlement works.
2. Remove the old key from the pool; restart again.
3. For a fee-bump signer, repeat with `FEE_BUMP_SECRET`, funding the new account before
   the old one is drained.

### Runbook: responding to an RPC outage

1. **Detect:** `/readyz` reports `rpc_reachable: false`; clients see
   `soroban_rpc_unreachable` and back off themselves.
2. **Contain:** traffic gating on `/readyz` stops routing new traffic; the circuit
   breaker refuses fast rather than hanging.
3. **Diagnose:** check the RPC provider's status; confirm `STELLAR_RPC_URL` /
   `STELLAR_RPC_URL_PUBNET` point where you think they do.
4. **Recover:** switch the RPC URL (env change + restart) or wait for the provider; the
   breaker half-opens probes and closes once the backend heals.
5. **Do not** restart-loop on `/healthz` — a restart cannot fix someone else's RPC.

### Runbook: settlement starting to fail

1. **Detect:** `/readyz` `signer_funded` fails, or `fee_spd` sits at the ceiling.
2. **Underfunded signer:** fund the account(s) above `READINESS_FUNDING_FLOOR_STROOPS`;
   readiness clears on the next check.
3. **Fee ceiling reached:** the meter working as designed. Raise `fee_spd` for the
   affected key or accept the cap — the ceiling bounds what an abusive caller can drain.
4. **Stuck signer:** remove the stuck account from `FACILITATOR_SECRETS`, restart,
   reconcile the sequence number, re-add once healthy.
5. **`submitted_outcome_unknown` callers:** tell them to look up the transaction hash
   on-chain before resubmitting — resubmitting a settled payment risks paying twice.

### Runbook: rollback

Revert to the previously known-good image tag/digest. If a migration shipped in the
failed deploy, verify the old image's schema compatibility before restarting it (see
[`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) § Rollback Procedure).

The same runbook, framed for the operator persona with the diagnosis steps spelled out,
is in [`docs/OPERATOR.md`](./OPERATOR.md) § 7.
