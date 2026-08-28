# Deployment Guide

The x402 facilitator is designed to be easily self-hostable.

## Container Build and Run

The project provides a multi-stage `Dockerfile` based on `node:20-alpine` (pinned by digest) and a `docker-compose.yml` for quick setup.

**To run locally with Docker Compose:**

```bash
# FACILITATOR_SECRET is the only required variable for testnet
export FACILITATOR_SECRET="S..." 
docker compose up
```

### Loading a .env file

For local (non-Docker) runs, the service loads a `.env` file from the working
directory at startup:

```bash
cp .env.example .env   # fill in FACILITATOR_SECRET
npm start
```

Properties of this mechanism, and why it is wired this way:

- **Development convenience only.** The file is loaded when `NODE_ENV` is not
  `production`. Production has no `.env`; there the environment comes from the
  orchestrator, so a stray `.env` left next to the image cannot shadow it.
- **Tolerant of absence.** No file, no error — the environment stands alone.
- **Real environment wins.** Variables already set in the environment are never
  overridden by `.env`. A stale local file cannot silently beat what a secrets
  manager injected.
- **`.env` is gitignored.** `FACILITATOR_SECRET` is a signing key.

### Validated cold-start path

On 2026-08-26 the documented path was walked from a clean clone, following only this
file and `.env.example`, against live Stellar testnet:

```bash
git clone <this repo>
npm ci
stellar keys generate facilitator --network testnet --fund   # or any funded S... key
export FACILITATOR_SECRET="$(stellar keys show facilitator --secret)"
npm start
```

Result: the process boots, `GET /healthz` returns `{ ok: true }`, `GET /supported`
advertises `extra.areFeesSponsored: true`, and `GET /readyz` reports `ready` with
`signer_funded: true` once the account is funded. The full `npm run e2e` conformance
run (unmodified canonical client, real testnet payment) also passes against the
locally-run facilitator.

Two things broke during that walk and were fixed in the same change:

- **`GET /readyz` always failed `signer_funded`** with a cryptic "Received undefined"
  error, even for funded accounts: the checker read `getLedgerEntries` responses as
  `entry.val`, but Soroban RPC returns the ledger data under `entry.xdr`. Fixed in
  `src/readiness.js`; the test stubs were updated to the real wire shape so the bug
  cannot ship again.
- **The e2e path could not start**: `npm ci` resolved an incoherent `@x402/*` set
  (`@x402/express@2.23` with `@x402/stellar@2.21`), and the newer express expected a
  `paymentFlows` API the older stellar did not expose. The `@x402/*` set was aligned
  to `2.23.0` (the drift this repo commits to tracking in
  [`docs/CONFORMANCE.md`](./CONFORMANCE.md)); the e2e script and MCP client were then
  updated for the client-side `spendControls` the new core enforces.

### Hosted deployment

**There is no publicly hosted instance of this facilitator today.** No URL is
operated, no availability commitment is made, and the README says so explicitly. The
hosted path — where it runs, its availability target and status page, and how a seller
obtains credentials — is tracked in
[#19](https://github.com/accensa/x402-facilitator-stellar/issues/19); until it lands,
teams wanting a hosted facilitator should run their own from this file or use the
upstream ecosystem's hosted option (see
[Stellar's x402 docs](https://developers.stellar.org/docs/build/agentic-payments/x402)).

What a hosted offering will need to state, per the RFP: testnet free and frictionless
(open mode is the default), mainnet pricing configurable rather than hardwired (fee
ceilings and per-key limits — see below), and an availability commitment that is
actually measured rather than claimed.

### Testnet and mainnet posture

| | Testnet (default) | Pubnet (opt-in) |
| --- | --- | --- |
| Enable | nothing to do | `ENABLE_PUBNET=true` **and** its own secret **and** its own RPC URL |
| Signer | `FACILITATOR_SECRET` / `FACILITATOR_SECRETS` | `FACILITATOR_SECRET_PUBNET` / `FACILITATOR_SECRETS_PUBNET` — never the testnet key |
| RPC | public endpoint by default | `STELLAR_RPC_URL_PUBNET` required; boot refuses the public endpoint |
| Caller auth | unset keys = open mode (free, frictionless; per-IP limits apply) | API keys strongly recommended; open mode discouraged |
| Fees | `MAX_TX_FEE_STROOPS` (default 50000) | `MAX_TX_FEE_STROOPS_PUBNET` (default 50000) — configurable, not hardwired |
| Rate limits | `RATE_LIMIT_GLOBAL`, per-key `RATE_LIMIT_<keyId>` | same, per deployment |

Boot enforces the separation: `ENABLE_PUBNET=true` without an independent pubnet
secret, or without `STELLAR_RPC_URL_PUBNET`, fails at startup rather than serving
mainnet with a testnet-shaped config.

### Deployment topology and client IP resolution

Whether the service can see the real client IP depends on what sits in front of
it:

| Environment | Topology | `TRUST_PROXY` |
|---|---|---|
| Local development | Direct connection | unset |
| docker-compose | Port published directly, no proxy | unset |
| Hosted (TLS terminator / load balancer / ingress) | 1+ reverse-proxy hops in front | hop count or proxy list |

With no proxy configured, Express's default applies: `req.ip` is the address of
the TCP peer. That is correct when clients connect directly — and wrong behind
a proxy, where every caller shares the proxy's address and, in open mode, one
rate-limit bucket.

When deployed behind a proxy, set `TRUST_PROXY` to the number of trusted proxy
hops (e.g. `TRUST_PROXY=1`) or an explicit list of proxy addresses/CIDRs
(e.g. `TRUST_PROXY=10.0.0.5,10.0.1.0/24`). The value is pinned to known
infrastructure on purpose: `true` is rejected at boot because it trusts the
leftmost `X-Forwarded-For` entry, which the client wrote itself and can forge.

Rate limiting keys on `req.keyId || req.ip`, so getting this right is also what
keeps open-mode callers out of each other's buckets.

### Environment Variables

| Variable | Required? | Description |
|---|---|---|
| `FACILITATOR_SECRET` | **Yes** | `S…` secret for the testnet signer. |
| `PORT` | No | Port to listen on (default `3402`). |
| `STELLAR_RPC_URL` | No | Testnet RPC provider (defaults to public testnet). |
| `STELLAR_RPC_URL_PUBNET` | Yes (if pubnet) | A provider URL is required for pubnet (see RPC Provider Decision). |
| `MAX_TX_FEE_STROOPS` | No | Fee ceiling per settlement on testnet (default `50000`). |
| `MAX_TX_FEE_STROOPS_PUBNET`| No | Fee ceiling per settlement on pubnet (default `50000`). |
| `FACILITATOR_API_KEYS` | No | Comma-separated API keys. Unset means open (correct for free testnet). |
| `ENABLE_PUBNET` | No | Set to `true` to enable pubnet. |
| `FACILITATOR_SECRET_PUBNET`| Yes (if pubnet) | `S…` secret for the pubnet signer. |
| `TRUST_PROXY` | No | Express trust proxy setting: hop count or proxy list (see topology above). Never `true`. |
| `REDIS_URL` | No | Shared rate-limit buckets across instances, e.g. `redis://redis:6379`. Unset = in-memory (or `RATE_LIMIT_STORE`). Takes precedence over `RATE_LIMIT_STORE`. |
| `DATABASE_URL` | No | Connection string for PostgreSQL (e.g., `postgres://user:pass@host:5432/db`). Enables persistent idempotency keys; required when `RATE_LIMIT_STORE=postgres`; unset otherwise = in-memory. With `VAULT_ADDR` set, must carry host/port/database **only** (no userinfo) — Vault supplies the credentials. |
| `VAULT_ADDR` | No | Enable HashiCorp Vault integration: Postgres credentials are fetched dynamically from Vault's database secrets engine instead of a long-lived password in `DATABASE_URL`. See below. |
| `VAULT_APPROLE_ROLE_ID` / `VAULT_APPROLE_SECRET_ID` | If `VAULT_ADDR` | The AppRole machine identity used to authenticate. The generated database credentials are short-lived and never appear in the environment or the logs. |
| `VAULT_DB_MOUNT` / `VAULT_DB_ROLE` | No | Database secrets engine mount (default `database`) and role (default `facilitator`) to read `creds` from. |
| `VAULT_POLL_INTERVAL_MS` | No | How often the lease-refresh loop checks whether credentials need rotating (default `10000`). |
| `RATE_LIMIT_STORE` | No | `memory` (default) or `postgres`. Postgres-backed shared rate-limit state across replicas — see below. Ignored when `REDIS_URL` is set. |
| `RPC_BREAKER_THRESHOLD` | No | Consecutive connection failures that open the RPC circuit breaker (default `10`). |
| `RPC_BREAKER_COOLDOWN_MS` | No | How long an open breaker waits before a half-open probe (default `30000`). |
| `READINESS_TIMEOUT_MS` | No | Per-call timeout for readiness checks, independent of the RPC retry budget (default `3000`). |
| `READINESS_CACHE_TTL_MS` | No | How long GET /readyz serves a cached result (default `5000`). |
| `READINESS_FUNDING_FLOOR_STROOPS` | No | Minimum signer balance reported by the readiness probe (default `0` = must exist). |
| `AUDIT_LOG_FILE` | No | File that receives audit records in addition to stdout. |
| `RATE_LIMIT_GLOBAL` | No | Global default limits as comma-separated `metric=value` pairs (`verify_rpm`, `settle_rpm`, `settle_rph`, `settle_rpd`, `fee_spd`, `catalog_rpm`); applies per IP in open mode. |
| `RATE_LIMIT_<keyId>` | No | Per-key overrides; any metric omitted falls back to the global. |
| `HORIZON_HEADERS_TIMEOUT_MS` | No | Response header timeout for Horizon/RPC sockets (default `30000`). |
| `RPC_FORCE_IPV4` | No | Force IPv4 for outbound RPC/Horizon connections (default `true`; set `false` to let the OS resolve). |
| `EMBEDDINGS_URL` | No | Embedding endpoint used by `/discovery/search` for semantic retrieval; unset = lexical only. |
| `ENABLE_RERANKING` | No | `true` turns on the second-pass reranker when an endpoint is available. |

## Shared Rate-Limit State

By default the rate limiter keeps its counters in process memory. That is fine
for one replica and zero-config testnet, but it has two consequences at scale:

- **A restart resets the daily fee ceiling** (`fee_spd`) — the only spend limit
  on sponsored fees.
- **N replicas enforce N separate limits** — every caller gets N× its
  allowance.

Two shared backends are available; both make replicas enforce one combined
limit and keep the fee ceiling alive across restarts:

- **Redis** — set `REDIS_URL`. If Redis becomes unreachable, an instance
  degrades to per-instance in-memory counters and logs a warning; the service
  stays up.
- **Postgres** — set `RATE_LIMIT_STORE=postgres` with `DATABASE_URL`. Increments
  are atomic single-statement upserts (`migrations/002_rate_limit_buckets.sql`,
  also created automatically on first use) — no lost counts under concurrency.
  Postgres was chosen as the second backend because it is already part of the
  stack, and its rows are never evicted: a fee counter is a value that must not
  be lost to an eviction policy (a Redis instance used for this table must run
  `maxmemory-policy noeviction`).

**Degrade behaviour differs by backend, deliberately:** Redis-backed limiting
fails open (the service stays up with per-instance counters); the Postgres
store fails CLOSED — checks refuse with reason `rate_limit_store_unavailable`
— because a limiter that cannot see its counters has no idea whether the fee
ceiling is spent, and answering "allowed" would mean unlimited sponsored spend
during an outage.

## CQRS Read Replica (Issue #121)

Settlement status reads and new settlement submissions currently share one
Postgres pool. Historical status queries (`GET /settlements/:key`) can block the
primary event loop and add latency to the write path that actually moves funds.
#121 separates the two concerns:

- **Writes stay on the primary.** `save`, `updateState`, and the idempotent
  upsert that backs `/settle` hit the `DATABASE_URL` pool only.
- **Reads go to the replica.** Status reads and the background reconciliation
  sweep hit the `DATABASE_URL_REPLICA` pool. Reads no longer contend with
  writes, so read throughput scales independently (replica pools open more
  connections: `max: 20` vs `max: 5` on the primary).

To enable it, provision a streaming replica of the primary (PostgreSQL native
replication via `pg_basebackup` + WAL follow — `docker-compose.yml` ships a
single-node `db-replica` that is the correct shape for local composition; run
≥ 2 nodes across failure domains in production), then set
`DATABASE_URL_REPLICA`. The primary's schema propagates to the replica via
replication; no separate migration is needed on the replica.

**Read-after-write consistency** (acceptance criterion: settle then immediately
GET the status): Postgres streaming replication is asynchronous, so a row can
be briefly invisible to the replica. The store handles this in three layers:

1. A row this process just wrote is always served from that process's in-memory
   copy — a replica read never touches our own fresh write.
2. A status read that the replica hasn't propagated yet retries (up to
   `SETTLEMENT_REPLICA_LAG_MS`, default `1000` ms).
3. If the replica still can't see the row, the read falls back to the primary
   before deciding it's a genuine miss — so a `404` is only returned once
   replication is confirmed to have drained.

Unset `DATABASE_URL_REPLICA` for the pre-#121 behaviour (single pool, reads and
writes on the primary) — this is the zero-config default and always correct.

## Health Endpoints and Probes

- `GET /healthz` — liveness. Always `{ ok: true }` while the process runs; no
  dependency checks. Point container/orchestrator **restart** logic here.
- `GET /readyz` — readiness. Checks each configured network's Soroban RPC
  reachability and the signer account's funded balance; returns `503` naming the
  failing check per network when any is unhealthy. Results are cached
  (`READINESS_CACHE_TTL_MS`) and each check runs under its own timeout
  (`READINESS_TIMEOUT_MS`), independent of the ~12s retry budget in the payment
  path. Point load-balancer **traffic gating** here.

## Vault Integration (Dynamic Database Credentials)

For deployments that cannot keep a long-lived database password in
`DATABASE_URL`, the facilitator can source credentials from HashiCorp Vault:

- **AppRole authentication** — the process logs in with
  `VAULT_APPROLE_ROLE_ID`/`VAULT_APPROLE_SECRET_ID` and gets a short-lived
  client token, re-authenticated before the token lease lapses.
- **Dynamic credentials** — database credentials are read from
  `VAULT_DB_MOUNT/creds/VAULT_DB_ROLE` (the database secrets engine). The
  username/password pair lives in memory only: it is never logged, never
  written to the environment, and never part of any diagnostic output.
- **Lease rotation** — a background loop refreshes the credentials as the
  lease approaches expiry (30% of the lease, bounded), and the Postgres pool
  starts using them for new connections immediately; existing connections are
  unaffected.
- **Graceful outage handling** — while a cached lease is still valid, a Vault
  outage is logged and the cached credentials keep working. Only a boot-time
  failure with no cached lease degrades further: the service starts without a
  database-backed pool and each store follows its documented degrade path
  (in-memory, or fail-closed for the shared rate limiter).

When Vault is enabled, `DATABASE_URL` must not embed credentials — a URL with
userinfo is refused at boot, because silently falling back to a static
password would defeat the entire point.

## Audit Log

Security-relevant events — settlements (with transaction hash), verifications,
catalog writes, authentication failures, and rate-limit rejections — are
recorded as structured JSON lines with `"channel": "audit"`, separable from
diagnostic logs. Set `AUDIT_LOG_FILE` to mirror them to a file with its own
retention handling. See `docs/AUDIT.md` for the event catalogue and retention.

## Horizontal Scalability

To run multiple instances behind a load balancer:

- **Rate limits** — set `REDIS_URL` (or `RATE_LIMIT_STORE=postgres`, above), so
  limits mean the same thing regardless of which node handled the request.
- **Idempotency** — set `DATABASE_URL`. Settlement retries are deduplicated via
  a Postgres table with a unique constraint, so a retry routed to a different
  instance replays the recorded response instead of settling twice. If Postgres
  is unavailable, idempotency degrades to process-local with a loud warning.
- **Catalog** — still per-instance in-memory; see Known Gaps.

The docker-compose file ships the backing services and wires the URLs.

## Secret Handling

The `FACILITATOR_SECRET` and `FACILITATOR_SECRET_PUBNET` are highly privileged keys. 

**How to supply secrets in production:**
Supply secrets via a secure secrets manager (like AWS Secrets Manager, HashiCorp Vault, or Kubernetes Secrets) and inject them as environment variables at runtime.

**How NOT to supply secrets:**
- DO NOT bake secrets into the container image (`ENV FACILITATOR_SECRET=...` in `Dockerfile`).
- DO NOT commit `.env` files containing real secrets to version control.
- DO NOT pass secrets directly on the command line where they land in shell history (e.g., `docker run -e FACILITATOR_SECRET=S...`).

## RPC Provider Decision

The default `@x402/stellar` package relies on the public Stellar testnet RPC. This is fine for testnet.
**However, for Pubnet:** The public endpoint is explicitly not something to run an availability target against. A pubnet deployment should use a dedicated RPC provider URL (e.g., Blockdaemon, QuickNode, or a self-hosted Horizon/Soroban RPC instance) via `STELLAR_RPC_URL_PUBNET`.

## Pubnet: key custody and rotation (#17)

Pubnet is where the money is real, so its keys warrant their own posture. The
`FACILITATOR_SECRET_PUBNET` (or the pool `FACILITATOR_SECRETS_PUBNET`) is the most
privileged material this service ever holds — whoever holds it can sponsor
settlements against real balances. Everything below follows from that.

### Generation and storage

- **Never reuse a testnet key on pubnet.** `config.js` refuses to boot with `ENABLE_PUBNET=true`
  unless an *independent* pubnet secret exists, because a testnet-shaped config on mainnet
  loses real money. The two secrets are unrelated keys.
- **Generate off any developer laptop.** Use the `stellar keys generate --network pubnet`
  flow (or a hardware/HSM-backed key) and store the secret in a secrets manager
  (AWS Secrets Manager, HashiCorp Vault, Kubernetes Secrets) — never in the image, a
  committed `.env`, or a shell history.
- **Where the pool uses multiple keys** (`FACILITATOR_SECRETS_PUBNET`), each signer is an
  independent Stellar account; they must each carry real pubnet balances sufficient to
  sponsor the fee ceiling and be funded before traffic is routed (#17). `GET /readyz`
  reports each signer's funded balance so a drained key fails readiness instead of
  surfacing as an opaque settle error.

### Rotation

A funded mainnet signer key is a liability that grows with balance, so plan rotation:

1. **Provision the new key** in the same secrets manager and fund it. Add it to the pool
   (`FACILITATOR_SECRETS_PUBNET`) on a rolling deployment — round-robin selection starts
   using it immediately without a hard cutover.
2. **Settle in-course through the old key.** Leave the old key in the pool until its
   sequence number is idle and no in-flight settlement references it, then remove it
   in a follow-up deploy. Abruptly dropping it mid-flight can strand a sponsored tx.
3. **Rotate the secrets manager entry**, deleting the old material from the manager and
   from any environment that ever saw it.
4. **Audit**: `AUDIT_LOG_FILE` records every settlement against the key that signed it
   (`actor` / signer workspaces) so a rotation can be verified after the fact.

### RPC provider

A mainnet deployment must use a dedicated `STELLAR_RPC_URL_PUBNET` (Blockdaemon,
QuickNode, or a self-hosted Soroban RPC instance) — the public endpoint is not an
availability target. Contract the provider separately with an availability commitment
before the first mainnet request; a provider blob on mainnet means sponsored
settlements fail and the signer pool idles with real funds.

### Fee ceiling and alerting

The per-day sponsored-fee ceiling (`settle_spd` / `fee_spd` rate limit) is what bounds
the loss a single compromised key can cause on pubnet. Configure `MAX_TX_FEE_STROOPS_PUBNET`
and the rate-limit ceiling deliberately, and have `/readyz` + `/metrics` alerting live
*before* the first mainnet request — see `docs/OPERATOR.md`.

## Database Provisioning and Migration

When `DATABASE_URL` is set, the database must be provisioned (PostgreSQL 16+)
and migrated before the main facilitator process binds to the port, so the
schema is ready when the first settlement arrives.

**Using node-pg-migrate (recommended):**

```bash
# Apply all pending migrations
npm run db:migrate

# Or in a Docker entrypoint:
node scripts/db-migrate.js up && node src/server.js
```

**For databases that already have the original SQL tables:**

If the database was provisioned with the original `.sql` migration files,
register them as applied so node-pg-migrate does not re-create them:

```bash
npm run db:seed-legacy
```

**Legacy manual approach (still supported):**

```bash
psql "$DATABASE_URL" -f migrations/001_bazaar_catalog.sql
psql "$DATABASE_URL" -f migrations/002_idempotency_keys.sql
psql "$DATABASE_URL" -f migrations/002_rate_limit_buckets.sql
```

After using the legacy approach on an existing database, run `db:seed-legacy`
to register the tables in the node-pg-migrate tracking table.

**Rolling back a migration:**

```bash
npm run db:migrate:down        # undo last migration
node scripts/db-migrate.js down 3  # undo last 3 migrations
```

**Checking migration compatibility (CI runs this automatically):**

```bash
npm run check:migration
```

See [MIGRATIONS.md](MIGRATIONS.md) for the full expand-and-contract
migration guide and runbook.

## Settlement Notifications (Transactional Outbox)

Settlement notifications are written to an `outbox_events` table in the SAME
transaction as the settlement state change (`settleAndEnqueue` in
`src/store/postgres.js`), then a background worker (`src/outbox/`) polls and
publishes them through the webhook dispatcher. If the process crashes after
settlement but before the broker accepts the message, the notification is still
in the outbox and is published on restart — at-least-once delivery, with the
database as the durability boundary.

- Enabled when `DATABASE_URL` is set (migration `004_outbox_events.sql` must
  be applied). Without Postgres, notifications fall back to the previous
  fire-and-forget direct publish.
- The worker polls every `OUTBOX_POLL_INTERVAL_MS` (default `5000` ms). It
  claims rows with `FOR UPDATE SKIP LOCKED`, so multiple replicas can run it
  without double-publishing; a claim carries a lease, so a worker that dies
  mid-publish is re-claimed and re-published by the next poll (duplicates are
  possible, loss is not).
- A row whose publish keeps failing is retried up to 10 times, then marked
  `failed` and left for an operator (visible via the `outbox_events` table).

## Resource Sizing

- **CPU/Memory:** The facilitator is a lightweight Node.js Express server. A base deployment of `1 vCPU` and `512MB RAM` is sufficient for typical workloads.
- **Signer Keys:** Testnet and pubnet signer keys must be strictly separated. Do not reuse the testnet key for pubnet. The `config.js` will explicitly fail if `ENABLE_PUBNET=true` is set without an independent pubnet secret.

## Rollback Procedure

To roll back a deployment:
1. Revert to the previously known-good container image tag/digest.
2. If a database migration was part of the failed deployment, evaluate if the previous version's code is compatible with the new schema (we aim for forward-compatible migrations). If not, apply the down-migration before restarting the previous image:
   ```bash
   npm run db:migrate:down
   ```
3. Restart the service.
