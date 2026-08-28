# Operator Guide: run, configure, and operate an x402 facilitator

This guide is for the person running a facilitator — for a product, for a team, or for
themselves. It covers both deployment paths (self-hosted and hosted), every
configuration knob, key management, rate limiting and metering, monitoring, and the
operational runbook. Detail lives in [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) (how to
deploy) and [`docs/OPERATIONS.md`](./OPERATIONS.md) (how to operate); this page is the
path through both.

By the end you will have:

1. A running facilitator, self-hosted or pointed at a hosted one, serving `stellar:testnet`.
2. It configured for your environment: keys, limits, fee ceilings, CORS, proxies.
3. A monitoring and alerting setup with a runbook for the failure modes that matter.

---

## 0. Decide: hosted or self-hosted

| | Self-hosted | Hosted |
| --- | --- | --- |
| What it is | You run the container / process | You point clients at a facilitator someone else runs |
| Getting started | §1 below | **Not yet offered publicly.** No hosted instance of *this* facilitator is operated at a URL anyone can reach today; the deployment, availability targets and status page are tracked in [#19](https://github.com/accensa/x402-facilitator-stellar/issues/19). Until then, teams that want a hosted facilitator can use the upstream ecosystem's hosted option (see [Stellar's x402 docs](https://developers.stellar.org/docs/build/agentic-payments/x402) for the OpenZeppelin Relayer plugin) or run their own from this repo. |
| Testnet | Free; open mode is fine | Free and frictionless is the requirement — see §3 |
| Mainnet | Fee ceilings and a dedicated RPC provider required | Pricing is operator-configurable, not hardwired — see §3 |

**Decision rule:** if you need a hosted instance today, you are self-hosting until
[#19](https://github.com/accensa/x402-facilitator-stellar/issues/19) lands. This
document states that plainly rather than implying a hosted offering exists.

---

## 1. Self-hosted: from clone to serving traffic

### Quickstart (local / evaluation)

```bash
git clone https://github.com/accensa/x402-facilitator-stellar.git
cd x402-facilitator-stellar

# The only required variable for testnet is a signer secret. Any S... key works;
# generate one that is actually funded so readiness passes:
stellar keys generate facilitator --network testnet --fund

export FACILITATOR_SECRET="$(stellar keys show facilitator --secret)"
npm ci
npm start
```

Verify from another terminal:

```bash
curl -s localhost:3402/healthz            # {"ok":true}
curl -s localhost:3402/readyz | jq .      # 200 with networks -> ready
curl -s localhost:3402/supported | jq '.extra.areFeesSponsored'   # true
```

`/readyz` checks each network's RPC reachability and the signer's funded balance; a
freshly funded account passes. If it reports `not_ready`, see the
[troubleshooting section](#7-troubleshooting-and-runbook).

### Docker / docker-compose

```bash
export FACILITATOR_SECRET="$(stellar keys show facilitator --secret)"
docker compose up --build
```

`docker-compose.yml` ships the backing services (Postgres for shared rate-limit state
and idempotency, Redis + Redlock quorum, Kafka for webhook delivery) and wires the URLs.
The Docker `HEALTHCHECK` targets `/healthz` (liveness); point orchestrator traffic
gating at `/readyz`.

### Production deployment

- **Image:** build from the pinned multi-stage `Dockerfile` (Node 20-alpine, non-root
  user). Tag by digest; never by `latest`-style floating tag.
- **Migrations:** when `DATABASE_URL` is set, apply `migrations/*.sql` before the
  process binds the port (init container or deploy step). They are forward-compatible.
- **Proxies:** set `TRUST_PROXY` (a hop count or explicit proxy list — never `true`) so
  rate limiting keys on the real client IP, not the proxy's.
- **Secrets:** from a secrets manager injected at runtime. Never baked into the image.
- **Multi-instance:** `REDIS_URL` (or `RATE_LIMIT_STORE=postgres`) for one combined rate
  limit across replicas; `DATABASE_URL` for durable idempotency; `REDIS_NODES` for
  distributed locking. In-memory stores are single-instance only.

The complete env-var table and topology guidance are in
[`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## 2. Every environment variable

`docs/DEPLOYMENT.md` has the full table; `examples/.env.example` at the repo root is the
checklist. The groups:

| Group | Variables |
| --- | --- |
| **Signers** (testnet) | `FACILITATOR_SECRET` or `FACILITATOR_SECRETS` (pool), optional `FEE_BUMP_SECRET` |
| **Signers** (pubnet, opt-in) | `ENABLE_PUBNET=true`, `FACILITATOR_SECRET_PUBNET` / `FACILITATOR_SECRETS_PUBNET`, optional `FEE_BUMP_SECRET_PUBNET`, required `STELLAR_RPC_URL_PUBNET` |
| **Network / fees** | `STELLAR_RPC_URL` (testnet RPC, defaults to public), `MAX_TX_FEE_STROOPS`, `MAX_TX_FEE_STROOPS_PUBNET` |
| **Caller auth** | `FACILITATOR_API_KEYS` (unset = open mode) |
| **Rate limits / metering** | `RATE_LIMIT_GLOBAL`, `RATE_LIMIT_<keyId>` per-key overrides, `RATE_LIMIT_STORE`, `DATABASE_URL`, `REDIS_URL` |
| **HTTP / CORS / proxy** | `PORT`, `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY`, `NODE_ENV` |
| **Shared stores** | `REDIS_URL`, `REDIS_NODES`, `DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`, `KAFKA_WEBHOOK_TOPIC`, `KAFKA_WEBHOOK_GROUP_ID`, `WEBHOOK_URL` |
| **Resilience** | `BREAKER_TIMEOUT_MS`, `BREAKER_ERROR_THRESHOLD_PERCENTAGE`, `BREAKER_RESET_TIMEOUT_MS`, `RPC_BREAKER_THRESHOLD`, `RPC_BREAKER_COOLDOWN_MS`, `RPC_FORCE_IPV4`, `HORIZON_MAX_SOCKETS`, `HORIZON_KEEP_ALIVE_TIMEOUT_MS`, `HORIZON_KEEP_ALIVE_MAX_TIMEOUT_MS`, `HORIZON_HEADERS_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS` |
| **Readiness** | `READINESS_TIMEOUT_MS`, `READINESS_CACHE_TTL_MS`, `READINESS_FUNDING_FLOOR_STROOPS` |
| **Audit / Bazaar** | `AUDIT_LOG_FILE`, `EMBEDDINGS_URL`, `ENABLE_RERANKING` |

**House rule:** a variable the code reads and `.env.example` does not document is a bug
— if you find one, fix `.env.example` in the same PR that touches the code.

---

## 3. Testnet vs mainnet posture

The RFP requires testnet be free and frictionless while mainnet pricing is
configurable, not hardwired. That distinction maps to configuration, and it is enforced
at boot:

**Testnet (default):**
- Free and frictionless: `FACILITATOR_API_KEYS` unset runs **open mode** — no keys
  needed, per-IP rate limits from `RATE_LIMIT_GLOBAL` still apply so one abusive client
  cannot drain the faucet. The server logs a loud warning at boot so the choice is
  never silent.
- Public RPC is fine: `STELLAR_RPC_URL` defaults to the public testnet endpoint.
- Fees: `MAX_TX_FEE_STROOPS` (default 50000 stroops = 0.005 XLM) is a ceiling, not a
  hardwired price.

**Pubnet (opt-in, and deliberately hard to trip into):**
- `ENABLE_PUBNET=true` **and** its own `FACILITATOR_SECRET_PUBNET` **and** its own
  `STELLAR_RPC_URL_PUBNET`. Boot refuses to serve pubnet with a testnet-shaped config
  or the public RPC endpoint — running a mainnet facilitator against the public
  endpoint is not something to run an availability target against.
- **Separate keys, always.** The testnet signer must never be reused on pubnet; config
  fails at boot if `ENABLE_PUBNET=true` without an independent pubnet secret.
- Pricing stays configurable per deployment via `MAX_TX_FEE_STROOPS_PUBNET` and the
  per-key rate-limit and fee-ceiling overrides — nothing is hardwired.

---

## 4. Key management

The signer keys are the crown jewels: they sponsor transaction fees, and a leaked
pubnet signer can be drained. Rules:

1. **Testnet and pubnet keys are different accounts.** Always. Enforced at boot.
2. **Inject at runtime** from a secrets manager (AWS Secrets Manager, Vault, K8s
   Secrets). Never `ENV FACILITATOR_SECRET=...` in the image, never in git, never in
   shell history (`docker run -e FACILITATOR_SECRET=...`).
3. **Separate the fee payer from the pool** with `FEE_BUMP_SECRET` when you want one
   funded account for fees while pool signers only manage sequence numbers. Trade-off:
   the fee-bump account becomes a single point of failure if its balance runs dry.
4. **Rotate by changing the env var and restarting** — key rotation and revocation
   require a process restart (no stateful sessions). Plan for a rolling restart.
5. **Fund every signer** above `READINESS_FUNDING_FLOOR_STROOPS`. `/readyz` checks all
   pool signers and the fee-bump account and goes 503 if any is underfunded.
6. **Watch for stuck signers.** `GET /metrics` exposes
   `x402_signer_selected_total{signer=...}` and `x402_signer_inflight{signer=...}`; a
   signer whose selection counter stops advancing while others continue has a
   desynchronized sequence number (see [`docs/OPERATIONS.md`](./OPERATIONS.md) §
   Multi-Signer Pool).

Caller API keys (`FACILITATOR_API_KEYS`) are a separate class: `name:secret` pairs,
held in memory as SHA-256 digests, never logged, compared in constant time. Unset =
open mode (testnet default).

---

## 5. Rate limiting and metering

The facilitator meters every paid route and enforces a **daily cumulative fee ceiling**
— the ceiling that caps how much sponsored spend your signers can be drained of in a
day.

**Global defaults** (`RATE_LIMIT_GLOBAL`, comma-separated `metric=value`):

```
RATE_LIMIT_GLOBAL="verify_rpm=60,settle_rpm=10,settle_rph=100,settle_rpd=1000,fee_spd=5000000,catalog_rpm=10"
```

| Metric | Meaning |
| --- | --- |
| `verify_rpm` | `/verify` requests per minute |
| `settle_rpm` | settlements per minute |
| `settle_rph` / `settle_rpd` | settlements per hour / per day |
| `fee_spd` | cumulative sponsored fee per day, in stroops — **the spend cap** |
| `catalog_rpm` | cataloguing operations per minute (also per-IP in open mode) |

**Per-key overrides** — `RATE_LIMIT_<keyId>`:

```
FACILITATOR_API_KEYS=admin:secret1
RATE_LIMIT_admin="verify_rpm=500,settle_rpm=50,fee_spd=10000000"
```

Unset metrics fall back to the global. In open mode, `RATE_LIMIT_GLOBAL` is enforced
per source IP instead of per key.

**Shared state across replicas:** in-memory counters mean N replicas enforce N limits
and a restart resets the fee ceiling. Set `REDIS_URL` (fails open to per-instance
counters) or `RATE_LIMIT_STORE=postgres` with `DATABASE_URL` (fails closed with reason
`rate_limit_store_unavailable` — a limiter that cannot see its counters must not answer
"allowed").

**CQRS read replica (#121):** settlement status reads and the reconciliation sweep can be
offloaded to a read replica with `DATABASE_URL_REPLICA` (plus a streaming replica),
keeping historical queries off the primary that carries new settlement submissions. See
[`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) for the read-after-write consistency behaviour.

**What callers see:** `429` with a reason code and `RateLimit-Limit` /
`RateLimit-Remaining` / `RateLimit-Reset` / `Retry-After` headers. `GET /usage` (API
key required — the one route that refuses open mode) shows a caller their own meters.
Full detail: [`docs/OPERATIONS.md`](./OPERATIONS.md).

---

## 6. Monitoring

### What the service exposes

| Endpoint | What it answers | Wire it to |
| --- | --- | --- |
| `GET /healthz` | liveness — `{ok:true}` while the process runs, no dependencies | container restart / process supervisor |
| `GET /readyz` | readiness — per-network RPC reachability + signer funding, 503 naming the failure | load balancer traffic gating, K8s readinessProbe |
| `GET /metrics` | Prometheus text: request/verify/settle counters, signer selection and in-flight gauges, circuit-breaker state | Prometheus + alerting |

### What to alert on (minimum viable set)

| Alert | Signal | Why it matters |
| --- | --- | --- |
| `/readyz` 503 | readiness check fails for any network | Every `/settle` will fail; stop routing traffic there |
| Signer balance below floor | readiness `signer_funded` fail, or a balance probe | No settlement can be sponsored; fund before the pool runs dry |
| `soroban_rpc_unreachable` in logs/audit | RPC circuit breaker open | Chain unreachable — the degraded-mode reason code is how clients distinguish this from a payment rejection |
| Stuck signer | `x402_signer_inflight` non-zero past max latency, or selection counter stalled | Sequence-number desync; throughput collapses silently |
| Fee ceiling near cap | `fee_spd` approaching the ceiling | The facilitator will start refusing settlements |

### The honest part

**This repo does not operate a monitored instance today**, so it makes no availability
claim — and **external monitoring, alert routing to a named owner, and a public status
page are open work tracked in [#19](https://github.com/accensa/x402-facilitator-stellar/issues/19)**,
which this document coordinates with rather than duplicates. What you can do *today*
for a self-hosted instance: scrape `/metrics`, probe `/readyz` from outside your
infrastructure on a schedule, alert on the signals above, and record the incident
history. The runbook below is written so an on-call engineer has a path even before the
status page exists.

---

## 7. Troubleshooting and runbook

### Deploying

1. Build and tag the image by digest; push to your registry.
2. Apply migrations before the process binds (`psql "$DATABASE_URL" -f migrations/001_bazaar_catalog.sql`, then `002_idempotency_keys.sql`).
3. Start, then gate traffic on `/readyz` going 200.
4. Smoke-test with a real payment before declaring the deploy done (the buyer guide's
   script in [`docs/BUYER.md`](./BUYER.md) is a ready-made smoke test).

### Upgrading

1. Check `docs/CONFORMANCE.md` and the diff of `package.json` for wire-format
   changes before upgrading — a bump of `@x402/*` can change response shapes
   (a CHANGELOG is tracked in [#212](https://github.com/accensa/x402-facilitator-stellar/issues/212)).
2. Rolling restart; both old and new must be able to serve `/verify` during the cutover.
3. If a database migration shipped, verify forward compatibility (the repo's migrations
   are designed to be; verify the previous image can still read the schema).

### Rotating keys

1. Generate a new keypair, fund it, add it to `FACILITATOR_SECRETS` alongside the old
   one (pool mode), restart, confirm `/readyz` passes and settlements work.
2. Remove the old key from the pool, restart again.
3. For a fee-bump signer, repeat with `FEE_BUMP_SECRET`, keeping the new account funded
   before the old one is drained of fees.

### Responding to an RPC outage

1. **Detect:** `/readyz` reports `rpc_reachable: false`; clients see
   `soroban_rpc_unreachable` with `Retry-After`-style backoff in their own retry loops.
2. **Contain:** traffic gating on `/readyz` stops routing new traffic; the circuit
   breaker refuses fast rather than hanging.
3. **Diagnose:** check the RPC provider's status page; confirm `STELLAR_RPC_URL` /
   `STELLAR_RPC_URL_PUBNET` point where you think they do.
4. **Recover:** switch the RPC URL (env change + restart) or wait for the provider; the
   breaker half-opens probes and closes once the backend heals.
5. **Do not:** restart-loop on `/healthz` — a restart cannot fix someone else's RPC.

### When settlement starts failing

1. **Detect:** `/readyz` `signer_funded` fails, or `fee_spd` is at the ceiling.
2. **Underfunded signer:** fund the account(s) above `READINESS_FUNDING_FLOOR_STROOPS`;
   readiness clears itself on the next check.
3. **Fee ceiling reached:** this is the meter working as designed. Decide whether to
   raise `fee_spd` for the affected key or accept the cap; the ceiling exists to bound
   what an abusive caller can drain.
4. **Stuck signer:** rotate the stuck account out of the pool (remove from
   `FACILITATOR_SECRETS`, restart), investigate the sequence-number desync, re-add once
   reconciled.
5. **`submitted_outcome_unknown` from a caller:** that is a client-side question — tell
   them to look up the transaction hash on-chain before resubmitting (see
   [`docs/BUYER.md`](./BUYER.md) § retry discipline).

### Rollback

Revert to the previously known-good image tag/digest. If a migration shipped in the
failed deploy, verify the old image's compatibility with the new schema before
restarting it (see [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) § Rollback).

---

## Reference

- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — the full deployment guide: topology, env
  vars, shared stores, sizing, rollback.
- [`docs/OPERATIONS.md`](./OPERATIONS.md) — rate limiting, metering, multi-signer pool,
  health endpoints in depth.
- [`docs/AUTHENTICATION.md`](./AUTHENTICATION.md) — caller auth, open mode, CORS.
- [`docs/CONFORMANCE.md`](./CONFORMANCE.md) — what "conforms" means and how it is kept
  honest.
- [`docs/THREAT-MODEL.md`](./THREAT-MODEL.md) — what the service assumes and defends.
- [`.env.example`](../.env.example) — the configuration checklist.
