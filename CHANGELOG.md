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

- `CHANGELOG.md`, so an integrator can tell what changed between two commits
  (#212).
- Tests for both documented CLI entry points, `validate-discovery` and
  `x402-mcp`, driven from the `package.json` `bin` map (#208).

### Changed

- Client IP addresses are pseudonymised before they reach a rate-limit bucket
  key or an audit actor, and are no longer written to logs. This makes the
  claim in `docs/PRIVACY.md` true for shared stores (Redis,
  `RATE_LIMIT_STORE=postgres`, the CRDT store) that previously persisted the raw
  address. `IP_HASH_SECRET` overrides the derived HMAC key (#204).

### Fixed

- `server.js` now installs `unhandledRejection` / `uncaughtException` handlers
  and reports a listen or metrics-listener bind failure, exiting non-zero with
  a diagnostic instead of dying silently (#205).

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
