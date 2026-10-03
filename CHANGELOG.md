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
- `npm run bench:signer`: a parameterised single-signer contention model that
  reports the ceiling and knee for a given sequence window and round trip, and
  refuses to report a knee from a sweep that never oversubscribed the signer
  (#203). With its defaults, one signer settles 3.2/sec (192/min) and stops
  scaling at 8 in-flight; past the knee throughput *falls*, because rejected
  submissions cost the same round trip. `docs/OPERATIONS.md` now sizes the
  signer pool against that number instead of alerting on any non-zero
  `x402_signer_inflight`.
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
- `GET /discovery/resource?url=…[&toolName=…]`: the point read behind the
  catalog listing, so a caller who knows a URL does not have to page the whole
  catalog to find it. Public, like the other discovery reads; a `404` carries
  reason `resource_not_found` and, deliberately, no cache headers — a cached
  "does not exist" would outlive the seller's registration (#222).
- `DELETE /discovery/resource?url=…[&toolName=…]`: removes a listing outright.
  The entry, its per-`payTo` accounting and its embedding all go, so a later
  `/verify` re-creates a fresh provisional listing rather than resurrecting the
  old one. Authenticated, metered against the catalog-write bucket, and audited
  as `catalog_delete`. Deletion is not scoped to the caller — nothing maps an
  API key to a `payTo`, so there is no ownership to enforce (#221).
- Per-key API key expiry and revocation (#207). `FACILITATOR_API_KEYS` entries
  may carry a third field, an expiry in epoch seconds (`admin:<secret>:1798761600`);
  `FACILITATOR_REVOKED_API_KEYS` names key ids to refuse. Both are enforced per
  request, not once at boot, and both are reported as distinct reasons
  (`expired_api_key`, `revoked_api_key`) so a withdrawn key is distinguishable
  from a wrong one in the audit trail.
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

- **Breaking:** API key secrets must be at least 32 characters, enforced at boot
  (#207). The stored digest is a single unsalted SHA-256 — not a work factor — so
  the secret's own entropy is the whole of the key's strength, and a short one is
  also cheap to brute-force offline if the digest ever leaks. A deployment with
  shorter keys will not start until they are regenerated with
  `openssl rand -base64 32`; the error names the offending key id.
- Client IP addresses are pseudonymised before they reach a rate-limit bucket
  key or an audit actor, and are no longer written to logs. This makes the
  claim in `docs/PRIVACY.md` true for shared stores (Redis,
  `RATE_LIMIT_STORE=postgres`, the CRDT store) that previously persisted the raw
  address. `IP_HASH_SECRET` overrides the derived HMAC key (#204).

### Fixed

- A failed re-embed no longer leaves the previous vector attached to a listing
  whose content has changed (#220). An upsert builds the new entry on top of the
  existing one, so it inherited the old vector; when the text changed, the dense
  search leg kept ranking the listing by content that no longer existed — and it
  did so silently, because a failed re-embed only logs a warning. The stale
  vector is now dropped synchronously, before the embed is attempted, so the
  resource ranks lexically while it waits and stays dropped if the re-embed
  fails. Each vector carries a fingerprint of the text it describes, so an
  unchanged listing keeps its vector and skips the provider call entirely.
- An `OPTIONS` preflight can now override the method list its route class
  advertises. The DLQ routes (`GET /admin/dlq…`) had been advertising
  `POST, OPTIONS` and `DELETE /discovery/resource` needed a union its class
  default could not express, so the preflight took a `methods` argument rather
  than guessing from the policy name.
- Dependency advisories published 2026-10-02 cleared: `fastify` 5.12.5 (five
  high-severity issues, including an authentication bypass through malformed
  URLs), `@grpc/grpc-js` 1.14.5 (error-message leakage), and `axios` 1.20.0
  pinned through a top-level `overrides` because `@stellar/stellar-sdk` pins it
  exactly. `@stellar/stellar-sdk` moves to 16.3.1 inside the existing
  `^16.2.0` range, so no direct dependency requirement changes.
  `npm audit --audit-level=high` now reports 0 vulnerabilities.
- Catalog descriptions are truncated at 200 characters without splitting a
  surrogate pair (#218). A description whose 200th UTF-16 code unit was the high
  half of an astral character (an emoji in a listing blurb) previously reached
  discovery with an unpaired surrogate attached — not valid UTF-16, rendered as
  U+FFFD by a conformant client and not round-trippable through a `jsonb`
  column. The emitted description is now always valid UTF-16 and never longer
  than 200 code units. The truncation is reported in a new `truncated` list on
  the envelope rather than as a soft drop (#219, below).
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
- `EXTENSION-RESPONSES` is now bounded to 4096 encoded bytes (#202). The
  envelope is built from caller-controlled fields and was previously unlimited;
  a header over a proxy's cap does not arrive truncated, it kills the response
  — after settlement. Envelopes that fit are byte-identical to before. Ones
  that do not degrade in tiers (drop `reason`, then all detail) while always
  preserving `status`, and each degradation is logged.
- A `description` containing markup is now refused rather than sanitized
  (#217). The previous tag-stripping regex was a sanitizer, not a boundary:
  `<scr<script>ipt>` stripped *to* `<script>`, `&lt;script&gt;` was not matched
  at all, and a truncated `onerror` tag with no closing `>` vanished silently.
  The field is dropped and the rest of the listing still lands
  (`partially landed`). A bare `&` — "Weather & tides" — is not markup and is
  unaffected.
- Truncated fields are reported in a new `truncated` list on the
  `EXTENSION-RESPONSES` envelope and the `POST /discovery/resources` response,
  separate from `softDrops` (#219). Previously a description shortened to 200
  characters was reported as the soft drop `description_truncated`, which read
  as "this field was dropped" — it was not, and no such field exists. A
  truncated description now reports `truncated: ["description"]` and leaves
  `reason`'s dropped-fields list alone.

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
