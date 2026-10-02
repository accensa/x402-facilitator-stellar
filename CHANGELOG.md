# Changelog

All notable changes to this project are documented in this file. An integrator
should be able to read what changed between two commits here rather than
reconstruct it from `git log`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0.0, a minor version may contain a wire-observable change — the
`@x402/*` response shapes are the compatibility surface, and
[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) is where the wire behaviour is
pinned.

## [Unreleased]

### Added

- Dynamic fee estimation from Horizon `/fee_stats`: p50/p90/p99 fee rates cached
  for 5s, a bid chosen from request priority and deadline, and a strict clamp to
  `MAX_TX_FEE_STROOPS`. Stale stats (or the protocol minimum) are used if Horizon
  is unreachable. New `HORIZON_URL` / `HORIZON_URL_PUBNET` settings; estimators
  are exposed as `feeEstimators` from `buildFacilitator` (#426).
- SEP-0007 `web+stellar:pay` URI parser and generator in the SDK
  (`parsePayUri`, `buildPayUri`, `payUriFromRequirements`), with strict
  rejection of malformed or ambiguous URIs and a conformance matrix built on the
  spec's own examples (#424).
- `npm run test:bench`: a resource-budget benchmark recording peak RSS, CPU
  utilization and open sockets, writing a markdown report and a run history, and
  failing on peak RSS above 512 MiB or a duration regression above 20% (#427).
- JSON-RPC 2.0 batch requests on the MCP server (stdio and HTTP): members run
  concurrently with isolated failures, responses are matched by id, and batches
  over 25 requests are refused. This replaces the previous blanket `-32600`
  rejection of arrays (#428).
- Optional mTLS client-certificate authentication for outbound webhooks. A
  delivery carrying `mtls.ref` is sent with a client certificate resolved from a
  ref, over a pooled per-credential agent, and still carries the existing HMAC
  signature when a secret is also configured. Credential references — never key
  material — are what travel on the Kafka wire record and in the dead-letter
  store, so rotation no longer requires a redeploy. Unavailable credentials
  degrade to signature-only delivery with a warning, and a receiver whose
  certificate fails verification is not retried (#429).
- Optional two-tier cache for catalog searches, behind `CATALOG_SEARCH_CACHE=1`:
  an in-process LRU in front of a shared Redis entry, with Redis Pub/Sub
  invalidation across replicas. The catalog write version is part of the cache
  key, so a cached search is never stale. Redis being unreachable degrades to
  querying the catalog directly. Adds the `x402_catalog_cache_lookups_total`
  series (#392).
- Semantic discovery over MCP: the `prompts` and `resources` halves of the
  protocol alongside the existing tools. Four `x402://catalog/…` resources expose
  the catalog, a search, one resource, and a per-network summary; three prompt
  templates (`generate_payment_uri`, `query_dispute_status`, `audit_transaction`)
  describe how to build and inspect a payment. Capabilities are advertised only
  when the server can serve them. A new input boundary validates every argument
  against a format — a transaction hash is 64 hex characters, a URL is http(s) —
  and seller-controlled catalog text is stripped of invisible characters and
  emitted inside a labelled data block, so a malicious listing cannot smuggle
  instructions into an agent's context (#391).
- `CHANGELOG.md`, so an integrator can tell what changed between two commits
  (#212).
- Tests for both documented CLI entry points, `validate-discovery` and
  `x402-mcp`, driven from the `package.json` `bin` map (#208).
- Secure client-IP resolution behind reverse proxies and CDNs, centralised in
  `src/trust-proxy.js` and wired into `src/app.js` ahead of the IP
  pseudonymiser. Behind Cloudflare, `CF-Connecting-IP` is honored
  automatically when the TCP peer is one of Cloudflare's published anycast
  ranges (the peer check is the trust boundary, so no `TRUST_PROXY` setting
  is required); from any other peer the header is ignored as client-writable
  noise. Behind an AWS ALB, `TRUST_PROXY=1` (or the ALB subnet's CIDR in a
  proxy list) resolves the client address from the rightmost
  `X-Forwarded-For` entry, which is the only entry a trusted proxy vouches
  for.

### Changed

- Client IP addresses are pseudonymised before they reach a rate-limit bucket
  key or an audit actor, and are no longer written to logs. This makes the
  claim in `docs/PRIVACY.md` true for shared stores (Redis,
  `RATE_LIMIT_STORE=postgres`, the CRDT store) that previously persisted the raw
  address. `IP_HASH_SECRET` overrides the derived HMAC key (#204).

### Fixed

- Catalog descriptions are truncated at 200 characters without splitting a
  surrogate pair (#218). A description whose 200th UTF-16 code unit was the high
  half of an astral character (an emoji in a listing blurb) previously reached
  discovery with an unpaired surrogate attached — not valid UTF-16, rendered as
  U+FFFD by a conformant client and not round-trippable through a `jsonb`
  column. The emitted description is now always valid UTF-16 and never longer
  than 200 code units, and the truncation is still reported as the
  `description_truncated` soft drop.
- `server.js` now installs `unhandledRejection` / `uncaughtException` handlers
  and reports a listen or metrics-listener bind failure, exiting non-zero with
  a diagnostic instead of dying silently (#205).
- A facilitator throwing a non-Error value (an object, a number) no longer
  surfaces `[object Object]` as `invalidMessage`/`errorMessage`: objects are
  JSON-stringified so their content reaches the client, while Error messages
  and strings pass through unchanged (#369).
- The `EXTENSION-RESPONSES` header on catalogable payments is now encoded
  lazily, when the response is actually serialized, instead of eagerly on
  every verify/settle. The bytes a bazaar client receives are unchanged
  (pinned byte-for-byte by tests); callers that never read the header no
  longer pay the JSON+base64 cost per payment (#368).

## [0.0.1] - 2026-08-11

Initial conformance spike: a minimal x402 facilitator for Stellar, built on
`@x402/stellar`.

### Added

- HTTP transport (`/verify`, `/settle`, `/supported`, `/usage`, health and
  readiness endpoints) over the upstream `ExactStellarScheme`.
- Caller authentication (API keys) and open mode, hop-count `TRUST_PROXY`
  resolution, and CORS by route class.
- Rate limiting and usage metering with a daily sponsored-fee ceiling,
  including shared stores for multi-instance and multi-region deployments.
- The Bazaar catalog: discovery and hybrid search, automatic cataloging,
  Postgres migrations, and an MCP server for agents.
- The `validate-discovery` seller CLI.
- Settlement store, idempotency, webhooks with a transactional outbox and a
  dead-letter queue, structured request logging, audit logging, Prometheus
  metrics, readiness probes and OpenTelemetry tracing.
- Pubnet support as an explicit opt-in with its own signer pool and fee
  ceiling.
