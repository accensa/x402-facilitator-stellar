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

---

# Availability, External Monitoring & Status (issue #19)

> **Status of this section.** These targets are the *commitment* a third party can
> depend on. They apply to any **publicly deployed** endpoint (see the deployment
> blocker [#16](https://github.com/accensa/x402-facilitator-stellar/issues/16)).
> Until an instance is reachable at a URL, the targets are published but unmet and
> the status page reports `no_sla` — that is the honest state, not a failure to
> measure. The whole point of this issue is to make "we don't know" impossible to
> hide: see the org's own silent indexer outage that lost 207 ledgers
> ([incident history](status/incidents.json)).

## Numeric availability & latency targets

All targets are measured by **external probes**, never by the service's own logs.
A number we report about ourselves is not a measurement.

### Availability per public endpoint

| Endpoint | Environment | Availability target | Measurement |
|---|---|---|---|
| `GET /healthz` | all | **99.9%** in 30d | external probe from outside our infra, 1-min interval |
| `GET /readyz` | all | **99.9%** in 30d | external probe, 1-min interval (503 counts as down) |
| `POST /verify` | all | **99.5%** in 30d | synthetic client, success-or-fast-fail (see degraded mode) |
| `POST /settle` | all | **99.5%** in 30d | synthetic client end-to-end on testnet |
| `GET /supported` | all | **99.9%** in 30d | external probe |
| synthetic E2E payment | testnet | **99.0%** in 30d | the probe that matters — see below |

"Down" for `/readyz` means a `503` or no answer within the probe timeout. A green
`/healthz` with a red synthetic payment is a **real outage** and is what the
synthetic-payment probe exists to catch.

### Latency targets (p50 / p95 / p99)

Measured at the probe from first byte out to last byte in, over a rolling **7-day**
window, reviewed **weekly** (see below).

| Endpoint | p50 | p95 | p99 | Notes |
|---|---|---|---|---|
| `POST /verify` | 150 ms | 600 ms | 1.5 s | read-only, no chain submit |
| `POST /settle` | 2 s | 6 s | 12 s | bounded by Soroban submit + confirmation |
| `GET /supported` | 20 ms | 80 ms | 200 ms | static config |
| `GET /healthz` | 5 ms | 20 ms | 50 ms | liveness only |
| `GET /readyz` | 50 ms | 200 ms | 500 ms | one RPC `getHealth` per network, cached 5 s |

`/settle` p99 is capped by `REQUEST_TIMEOUT_MS` (default 30 s) and the RPC retry
budget; a settle that exceeds p99 should be failing fast, not hanging.

### Measurement window & review

- **Window:** availability is computed over a **rolling 30 days**; latency over a
  **rolling 7 days**. Both are recomputed every probe cycle and rendered on the
  status page.
- **Reviewer:** the **Facilitator On-Call** (named in [Alerting &
  Escalation](#alerting--escalation)) reviews the weekly digest every Monday
  09:00 UTC and records the verdict in `status/incidents.json` as a `review`
  entry. Missing a review is itself an incident.
- **Public record:** the raw probe results feed `status/status.json`; the status
  page is the single source of truth a dependent can cite.

## External monitoring

Probes run from **outside our own infrastructure** so a silent outage on our side
cannot also silence its own monitor. In this repo that is a GitHub Actions cron
workflow (`.github/workflows/external-monitor.yml`) executing
`monitoring/probes.mjs` from GitHub's runners against the public endpoint. A
self-hosted deployment should point the same script at a separate cloud account.

### Minimum probe set

1. **Liveness** — `GET /healthz` per environment. Expects `200 { ok: true }`.
2. **Readiness** — `GET /readyz` per environment. Expects `200`; a `503` is a
   pageable "instance cannot settle" signal, not a restart trigger.
3. **Synthetic end-to-end payment** — a real `/verify` + `/settle` round trip on
   **testnet** on a schedule (default every 15 min). This is the probe that
   matters: liveness can be green while settlement is broken. It reuses the
   unmodified canonical client path from `scripts/e2e.mjs` so it exercises the
   same wire contract a real payer does.
4. **Signer balance** — for each network, read the facilitator signer account
   balance via RPC and alert **before** it runs dry (`SIGNAL_FLOOR_STROOPS`),
   warn at `WARN_FLOOR_STROOPS`. A dry signer is a hard settlement outage.

### Probe output contract

`monitoring/probes.mjs` exits non-zero on any failed probe and writes
`monitoring/out/status.json` with the per-probe result, latency, and a
`degraded`/`down` verdict. The status-page publish workflow consumes that file.

## Alerting & escalation

An alert with no owner is a log line. Every alert below routes to a **named
recipient** with a documented **escalation path**.

| Alert | Severity | Owner (named recipient) | Escalation path |
|---|---|---|---|
| `/healthz` down (any env) | SEV2 | Facilitator On-Call | page → if no ack in 15 min, escalate to Accensa maintainers (SUPPORT.md channels) |
| `/readyz` 503 (cannot settle) | SEV1 | Facilitator On-Call | page → 15 min → maintainers; open incident in `status/incidents.json` |
| Synthetic payment failed | SEV1 | Facilitator On-Call | page → 15 min → maintainers; this is the "liveness green, settlement broken" case |
| Signer balance < WARN floor | SEV3 | Facilitator On-Call | notify; fund pool before it hits SIGNAL floor |
| Signer balance < SIGNAL floor | SEV1 | Facilitator On-Call | page + auto-open incident; settlements will fail until funded |
| RPC unreachable (breaker open) | SEV1 | Facilitator On-Call | page → maintainers; verify provider, not our code |
| Settlement store unavailable | SEV1 | Facilitator On-Call | page; `/settle` already refuses fast (`settlement_store_unavailable`) |

**Named recipient.** The recipient is the **Accensa Facilitator On-Call**,
reachable through the channels in [`SUPPORT.md`](SUPPORT.md) (Telegram / Discord)
and the `FACILITATOR_ONCALL_EMAIL` secret. On-call rotation is owned by the
Accensa maintainers. **Escalation** is always: On-Call → Accensa maintainers →
org owners; the same channels are the human escalation path, so a rotated invite
link changes one file, not every runbook.

## Degraded-mode behaviour

Fail fast with a documented reason; never hang. (The "why" for each is in
`src/readiness.js` and `src/app.js`.)

### RPC unreachable

- The RPC circuit breaker (`RPC_BREAKER_THRESHOLD` / `RPC_BREAKER_COOLDOWN_MS`)
  opens after consecutive failures and `/settle` returns `soroban_rpc_unreachable`
  immediately — it does **not** inherit the ~12 s retry budget.
- `/readyz` reports `rpc_reachable: false` per network; orchestrators stop routing
  here. `/healthz` stays green (a downstream outage must not restart us).
- Probe timeout is bounded by `READINESS_TIMEOUT_MS` (3 s) so a dead RPC fails
  fast instead of hanging the probe window.

### Database / settlement store unavailable (#10)

- With `SETTLE_REQUIRE_DURABLE_STORE=true` and `DATABASE_URL` set, if the durable
  settlement store is down, `/settle` refuses with `settlement_store_unavailable`
  (503) and a clear message — **it does not settle without a record**. This is the
  fix for "settle without a record" double-spend risk on retry.
- `/verify` is **never** gated by the store — verification reads no durable state,
  so it stays fully available during a DB outage.
- Without the flag (open testnet, no `DATABASE_URL`), the in-memory fallback is
  intentional and the gate does not apply.

### Signer stuck / underfunded

- `/readyz` reports `signer_funded: false` and `503`s when any pool signer is
  below `READINESS_FUNDING_FLOOR_STROOPS`.
- Stuck signers are detected from Prometheus metrics (`x402_signer_selected_total`
  flat while peers advance, or `x402_signer_inflight` stuck above max latency).
  On detection: drain traffic from that replica (readiness already 503s per
  network) and rotate the stuck signer out of `FACILITATOR_SECRETS`; do not retry
  forever against a desynced sequence number.

## Status page

A public status page lives in `status/` and is published to GitHub Pages
(`.github/workflows/publish-status.yml`). It shows current state from
`status/status.json` and an **incident history** from `status/incidents.json`.
The README links to it. The incident history is the trust-building half: a status
page with no incidents ever recorded is not credible, so the history starts with
an honest pre-deployment entry documenting the silent-outage risk this issue
closes.

## Runbooks (per alert)

Each runbook: **what fired → what to check → what to do.** Kept inline so the
alert and the fix travel together.

### `/readyz` 503 — instance cannot settle
- **Fired:** `/readyz` returned 503 for a network.
- **Check:** read `networks[].rpc_reachable` and `networks[].signer_funded` in the
  response. `breakers` shows open breakers; `catalog` is reported but never the
  cause.
- **Do:** if `rpc_reachable:false` → RPC provider down, verify `STELLAR_RPC_URL`,
  breaker cools down on its own. If `signer_funded:false` → fund the signer above
  the floor; traffic resumes automatically on next probe.

### Synthetic payment failed
- **Fired:** the E2E probe could not `/verify`+`/settle` on testnet.
- **Check:** `/healthz` (is the process up?), `/readyz` (can it settle?),
  signer balance, and the probe's captured error. A green `/healthz` + red
  synthetic payment is the exact "settlement broken but alive" case.
- **Do:** reproduce with `npm run e2e` against the instance; check RPC breaker,
  signer funding, and `REQUEST_TIMEOUT_MS`. Open an incident.

### Signer balance below floor
- **Fired:** signer XLM (or asset) dropped under WARN/SIGNAL floor.
- **Check:** `signer_funded` in `/readyz`; confirm on explorer.
- **Do:** fund the signer before it hits the SIGNAL floor. Below SIGNAL, settlements
  fail — page and fund immediately; rotate the account if compromised.

### RPC breaker open
- **Fired:** `breakers` shows `open` for a network's RPC host.
- **Check:** is the provider reachable from elsewhere? Is it our egress?
- **Do:** confirm provider status; breaker half-opens after `RPC_BREAKER_COOLDOWN_MS`.
  If provider is dead, switch `STELLAR_RPC_URL` and redeploy.

### Settlement store unavailable
- **Fired:** `SETTLE_REQUIRE_DURABLE_STORE=true` and Postgres down → `/settle`
  returns `settlement_store_unavailable`.
- **Check:** `DATABASE_URL` reachability; Postgres logs.
- **Do:** restore Postgres; `/settle` auto-recovers. `/verify` stayed up throughout.
  Do **not** disable the flag to "fix" the alert — that removes the guard.

