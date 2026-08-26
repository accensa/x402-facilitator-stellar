# Operations & Rate Limiting

The x402 facilitator includes a sliding-window rate limiter and usage meter. This protects the service from abuse and limits the cumulative fee exposure, as the service sponsors Stellar transaction fees for every settlement.

## Health Endpoints

Two endpoints, two different questions — keep them straight:

### `GET /healthz` — liveness

Always returns `200 { ok: true }` while the process runs. It performs **no
dependency checks**, deliberately: a liveness probe that fails on a downstream
outage triggers restart loops that make the outage worse (and a restart cannot
fix someone else's RPC). The Docker `HEALTHCHECK` targets this endpoint.

### `GET /health/ready` — readiness

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
balancers, Kubernetes `readinessProbe`) → `/health/ready`.

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
