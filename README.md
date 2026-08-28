<div align="center">
  <h1>x402-facilitator-stellar</h1>
  <p><strong>An x402 facilitator for Stellar — verify, settle, supported</strong></p>
  <p>
    <img src="https://img.shields.io/github/actions/workflow/status/accensa/x402-facilitator-stellar/ci.yml?branch=main" alt="CI Status" />
    <img src="https://img.shields.io/badge/status-conformance%20spike-orange.svg" alt="Status: conformance spike" />
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License Apache 2.0" />
    <img src="https://img.shields.io/badge/stellar-testnet-success.svg" alt="Stellar testnet" />
    <img src="https://img.shields.io/badge/x402-v2-blue.svg" alt="x402 v2" />
  </p>
  <p>
    <a href="#conformance"><strong>Conformance</strong></a> ·
    <a href="#documentation"><strong>Documentation</strong></a> ·
    <a href="#known-gaps"><strong>Known Gaps</strong></a> ·
    <a href="https://github.com/accensa"><strong>Accensa org</strong></a> ·
    <a href="https://github.com/x402-foundation/x402"><strong>x402 spec</strong></a>
  </p>
</div>

> Developer infrastructure for x402 on Stellar, built on the Apache-2.0
> [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) package. Independent of
> the merchant back-office in [`accensa-app`](https://github.com/accensa/accensa-app) and
> [`accensa-contracts`](https://github.com/accensa/accensa-contracts) — a seller can use
> those without this, and an agent can use this without those.

> [!WARNING]
> **This is a conformance spike, not a production facilitator.** It exists to answer one
> question: can an unmodified canonical x402 client complete a payment against a
> facilitator we operate on Stellar testnet? **As of 2026-08-26 the answer is yes across
> all five upstream server components** — 10 of 10 scenarios in the upstream e2e suite,
> with settled transactions anyone can verify. See [Conformance](#conformance). It makes
> no availability claim and is not deployed anywhere you can reach.

## The Problem

x402 turns HTTP 402 into a machine-native payment flow: a client requests a resource, the
server replies `402` with terms, the client signs a payment authorization and retries, and
a **facilitator** verifies and settles on-chain before the resource is returned.

The facilitator is the piece a seller cannot easily run themselves. It has to validate
Soroban authorization entries strictly — correctly signed, authorizing exactly the
declared call, asset, amount and recipient, not replayed, not expired — submit the
invocation, and cover the network fee so the buyer needs only the payment asset. Get any
of that subtly wrong and the failure is silent: payments that look settled and are not,
or authorizations that grant more than the payer understood.

## Why Not Reimplement It

`@x402/stellar` already ships `ExactStellarScheme`, which implements the
`SchemeNetworkFacilitator` interface — `verify`, `settle`, `getExtra`, `getSigners` —
and validates:

- auth-entry structure and credential type
- expiration against a maximum ledger
- **facilitator safety** — the facilitator must not be a party to the transfer
- **absence of sub-invocations** — no authorization the payer did not see
- payer signature status, and that no other signatures are pending
- via simulation, that there is **exactly one** transfer event matching the expected
  sender, recipient, amount and asset

None of that is reimplemented here. It is the part most dangerous to get subtly wrong, and
rewriting it would duplicate the package the ecosystem is standardizing on.

**This repo is the transport around it.** `@x402/core` ships no facilitator router — it
gives you `x402Facilitator` with `verify()`, `settle()` and `getSupported()`, and the HTTP
surface is yours to write. That surface, plus configuration, caller authentication and
operational concerns, is what lives here.

## Documentation

Published docs for the whole organisation, including this service, are at
**<https://accensa.github.io/accensa-app/docs/facilitator/overview>**.

In-repo, refer to the [Documentation Hub](docs/README.md) for detailed role-based guides:
- [Seller Guide](docs/SELLER.md)
- [Buyer / Agent Guide](docs/BUYER.md)
- [Operator Guide](docs/OPERATOR.md)

Reference material: [Architecture](docs/ARCHITECTURE.md) ·
[Bazaar discovery](docs/BAZAAR.md) · [MCP server](docs/MCP.md) ·
[Conformance](docs/CONFORMANCE.md) · [Deployment](docs/DEPLOYMENT.md) ·
[Operations](docs/OPERATIONS.md) · [Authentication](docs/AUTHENTICATION.md) ·
[Business model](docs/BUSINESS-MODEL.md) · [Threat model](docs/THREAT-MODEL.md) ·
[Audit readiness](docs/AUDIT.md) · [Privacy](docs/PRIVACY.md) ·
[Glossary](docs/GLOSSARY.md)

Sibling repositories in the [Accensa organisation](https://github.com/accensa):
[`accensa-app`](https://github.com/accensa/accensa-app) (merchant dashboard, indexer,
`@accensa/sdk`) and
[`accensa-contracts`](https://github.com/accensa/accensa-contracts) (Soroban receipt
anchoring and refund vault). A seller can use those without this, and an agent can use
this without those.

### Running Locally

The service loads a `.env` file at startup in non-production environments
(`NODE_ENV !== 'production'`) — nothing breaks when the file is absent, and
variables set in the real environment always win over `.env`, so a stale local
file cannot silently override what a deployment injected. Production skips the
file entirely: there, the environment comes from the orchestrator.

```bash
cp .env.example .env   # then fill in FACILITATOR_SECRET
npm start              # or: npm run dev (adds --watch)
curl localhost:3402/healthz
curl localhost:3402/readyz
```

`FACILITATOR_SECRET` is a signing key. `.env` is gitignored — never commit it.

### Testnet Setup

Payments on Stellar need funded accounts, and USDC-priced payments additionally need
**trustlines** — an account cannot hold or spend an issued asset until it has
authorized the issuer. This is the most common way a first x402 payment fails, so
it is documented (and scripted) rather than left to a deep stack trace. Two helpers
in `scripts/` handle the testnet side, wired to npm:

```bash
npm run fund:testnet        # scripts/fund-testnet-accounts.mjs
npm run prepare:testnet-usdc  # scripts/prepare-testnet-usdc.mjs
```

- `npm run fund:testnet` creates three fresh accounts (client, server/payee,
  facilitator), funds them via Friendbot, **opens a USDC trustline on each**, and
  prints the credentials as env assignments (`--json` / `--github-env` for other
  formats).
- `npm run prepare:testnet-usdc` puts existing payer/payee accounts into a
  pay-ready state: USDC trustlines on both, and a small USDC balance on the payer
  drawn from `TESTNET_USDC_TREASURY_SECRET` (testnet-only; reports
  `usdc_ready=false` honestly when the treasury is absent).

What trustlines are, who needs which, and the mainnet path (same `changeTrust`
mechanism, no Friendbot) are in the [Seller Guide](docs/SELLER.md#trustlines) and
[Buyer / Agent Guide](docs/BUYER.md#trustlines); both examples
([`examples/http-seller`](examples/http-seller/README.md),
[`examples/mcp-agent`](examples/mcp-agent/README.md)) state their prerequisite
up front.

### Tests

```bash
npm test              # unit tests — no network, no funded account, no .env
npm run lint          # eslint
npm run format:check  # prettier, check only
npm run licenses      # fails on any AGPL in the dependency path
```

All four run in CI on every push and pull request, across Node 20 and 22.

The end-to-end conformance run is separate, because it needs testnet and two
funded accounts:

```bash
FACILITATOR_SECRET=$(stellar keys show facilitator) npm start &
ALICE_SECRET=$(stellar keys show alice) npm run e2e
```

### Privacy and Data Minimisation

The X402 Facilitator handles sensitive transaction and search query data. Our approach is to collect only what is necessary, and to aggressively purge it according to strict retention policies.
For detailed information, see our [Privacy Policy](docs/PRIVACY.md).

### Observability

The transport emits one structured JSON line per request to stdout and exposes
Prometheus metrics on `GET /metrics`. Configure `LOG_LEVEL` (verbosity) and
`METRICS_PORT` (bind metrics to a separate, unauthenticated port) via the
environment — see `.env.example` and [Operations](docs/OPERATIONS.md)
for the log fields and the alert to set on each metric.

## Conformance

Acceptance is tested at the wire level with stock SDK code, not by reading a claim. What
holds today on testnet:

- [x] `/supported` emits the Stellar `extra` block including `areFeesSponsored`
- [x] Every rejection carries a non-null `invalidReason` — across malformed bodies,
      unregistered scheme/network pairs, and scheme-level failures
- [x] The spec's `payload: {transaction}` shape is accepted verbatim
- [x] **An unmodified canonical client completes a payment end-to-end**
- [x] **Settled transaction hash published** — see the conformance table below
- [x] **The x402 repository's e2e suite — 5 of 5 server components pass** (10/10
      scenarios across `express`, `fastify`, `hono`, `next`, `mcp`, 2026-08-25/26)
- [ ] `stellar:pubnet` (code-path verified; on-mainnet proof pending funded keys [#17])

### Settled on Stellar testnet, 2026-08-14

An unmodified `typescript/http/fetch` client received a `402` with terms, signed a payment
authorization, retried, and this facilitator verified and settled it on-chain — paying the
network fee itself, so `areFeesSponsored` is observed rather than merely advertised.

| Transaction | Ledger | Settled |
|---|---|---|
| [`5f1bd15a…5558`](https://stellar.expert/explorer/testnet/tx/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558) | 4134781 | 08:15:33Z |
| [`ff798145…0590`](https://stellar.expert/explorer/testnet/tx/ff798145681ad66e20f39f60d91895e993bc8033bbc78847aa5ddf0ee1e70590) | 4134928 | 08:27:49Z |

Both report `"successful": true` from Horizon. Verify without trusting this file:

```bash
curl -s https://horizon-testnet.stellar.org/transactions/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558 \
  | jq '{successful, ledger, created_at}'
```

### The full matrix passes — 2026-08-25/26

The August 14 run was the first with a real USDC treasury: one payment settled and four
scenarios failed — `express`, `fastify`, `hono` and `mcp` — with `Payment response header
not found` or upstream's `402 facilitator_error`, and the facilitator's four lines of
output made the failures undiagnosable. That was tracked in
[#64](https://github.com/accensa/x402-facilitator-stellar/issues/64) and blocked on
[#7](https://github.com/accensa/x402-facilitator-stellar/issues/7), request-scoped
structured logging, request correlation and `/metrics`.

Both are done. The daily upstream suite has passed **10 of 10 scenarios on two
consecutive nights** (2026-08-25, 2026-08-26): all five server components (`express`,
`fastify`, `hono`, `next`, `mcp`) × the plain and `upfront` payment flows, each with a
settled transaction hash on testnet. The facilitator now logs one structured line per
request with redacted headers — a verify/settle outcome and rejection reason on every
call — plus an `audit` channel and `/metrics`, so a future failure is attributable to a
specific request instead of a four-line mystery.

The full record, including the treasury prerequisite that had to be solved first and how
to reproduce the runs, is in [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md).

Responses use the canonical field names — `VerifyResponse` carries `invalidReason` and
`invalidMessage`; `SettleResponse` carries `errorReason`, `errorMessage`, `transaction`
and `network`. The transport-layer HTTP rejections (such as 401 Unauthorized or 429 Too Many Requests) also conform to the `VerifyResponse` shape to ensure a client has one parser, not three. For an exhaustive taxonomy of all emitted reasons, see [REASONS.md](docs/REASONS.md).

## Known Gaps

- **Bazaar is built but unproven against a second implementation.** Discovery, search and
  automatic cataloging landed on 2026-08-12 and are documented in
  [`docs/BAZAAR.md`](docs/BAZAAR.md): a catalog datastore with migrations,
  `GET /discovery/resources` with the full upstream filter set, `GET /discovery/search`
  with lexical and hybrid (dense-embedding + reranking) retrieval, automatic cataloging
  off the payment path, `EXTENSION-RESPONSES` reporting, and an MCP server
  ([`docs/MCP.md`](docs/MCP.md)). A search-evaluation harness and judgement set live in
  `eval/`. **On 2026-08-14 another party's client read this catalog for the first time
  and its listing was rejected** — upstream registers wildcard `*` route templates and
  this repo's validation hard-drops them as `invalid_routeTemplate`
  ([#65](https://github.com/accensa/x402-facilitator-stellar/issues/65)).
- **No deployment.** There is a `Dockerfile`, a `docker-compose.yml` and
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), but no instance is running at a URL anyone
  can hit. Availability targets and a status page are tracked in
  [#19](https://github.com/accensa/x402-facilitator-stellar/issues/19).
- **No persistence by default.** The catalog has a PostgreSQL schema in `migrations/` and
  uses it when `DATABASE_URL` is set; the settlement path holds nothing durable, tracked
  in [#10](https://github.com/accensa/x402-facilitator-stellar/issues/10). When
  `DATABASE_URL` is set you can also add `DATABASE_URL_REPLICA` to offload settlement
  status reads and the reconciliation sweep onto a read replica (CQRS fallback to primary
  on replication lag) — see `docs/DEPLOYMENT.md` (#121).
- **`exact` only.** The `upto` scheme has no Stellar specification yet; design notes in
  [`accensa-contracts/docs/ADR-002`](https://github.com/accensa/accensa-contracts/blob/main/docs/ADR-002-upto-scheme.md).
- **Pubnet is code-served but unproven on mainnet (#17).** `stellar:pubnet` is served with
  its own signer pool, RPC provider and fee ceiling, none shared with testnet, and that
  isolation plus both-networks `/supported` advertising and 7-decimal amounts are pinned by
  `test/pubnet-conformance.test.js`. What remains is operational, not code: a canonical
  client completing a real USDC payment on mainnet with the settled hash published needs
  funded pubnet keys and a contracted RPC, which no CI secret can supply. State and the
  key-custody/rotation posture are in `docs/DEPLOYMENT.md`; the checkbox above stays
  unchecked until that proof lands.

## Contributing

Issues and pull requests welcome. Given the status above, the most useful contribution is
a conformance failure: point a canonical client at it and report what breaks.

## Contributors

<a href="https://github.com/accensa/x402-facilitator-stellar/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=accensa/x402-facilitator-stellar" />
</a>

## License

Apache-2.0 — see [LICENSE](LICENSE). Chosen to match upstream `@x402/*` so work here can
be contributed back.
// fix
