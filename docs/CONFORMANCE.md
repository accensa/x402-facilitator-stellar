# Conformance

Conformance here is judged at the wire level: stock SDK code is pointed at this
service rather than a claim being read. The strongest available form of that is
the **x402 project's own end-to-end suite**, unmodified, run against our
facilitator — a suite we wrote can be unconsciously shaped to fit what we built;
the upstream one cannot.

This document records how that suite is invoked, what it requires, and what it
found. It is the artifact; the CI job is the automation that keeps it honest.

---

## 1. Where the suite lives, and what shape it is

`x402-foundation/x402` → [`e2e/`](https://github.com/x402-foundation/x402/tree/main/e2e).

It is **not** a test file you point at a URL. It is a matrix harness that spawns
components — clients, resource servers and facilitators — and runs every valid
combination of the ones you select. Layout is `role/language/transport/component`.

The parts that matter to us:

| Path | What it is |
|---|---|
| `e2e/test.ts` | Entry point, run via `pnpm test` |
| `e2e/config/mechanisms_<id>.json` | Source of truth per network — env, CAIP-2 identity, routes |
| `e2e/facilitators/{typescript,go,python}` | The reference facilitators the suite ships |
| `e2e/facilitators/external-proxies/` | **Where a third-party facilitator plugs in.** Gitignored upstream |
| `e2e/src/proxy-base.ts` | Spawns a component and waits for a ready line on stdout |

### Stellar is a first-class family upstream

From [`e2e/config/mechanisms_stellar.json`](https://github.com/x402-foundation/x402/blob/main/e2e/config/mechanisms_stellar.json):

```json
{
  "env": {
    "SERVER_STELLAR_ADDRESS":         { "required": true, "roles": ["server"] },
    "CLIENT_STELLAR_PRIVATE_KEY":     { "required": true, "roles": ["client"] },
    "FACILITATOR_STELLAR_PRIVATE_KEY":{ "required": true, "roles": ["facilitator"] }
  },
  "testnet": { "caip2": "stellar:testnet", "rpcUrlDefault": "https://soroban-testnet.stellar.org" },
  "mainnet": { "caip2": "stellar:pubnet",  "rpcUrlDefault": "https://mainnet.sorobanrpc.com" },
  "routes": {
    "/exact/stellar": { "scheme": "exact", "sdks": ["typescript"], "price": { "usd": "$0.001" }, "extensions": ["bazaar"] }
  }
}
```

Three things worth reading off that:

- the paid route is **`/exact/stellar` at $0.001**, `exact` scheme, TypeScript SDKs only;
- it declares the **`bazaar` extension**, so the discovery work in this repo is on
  the same path the suite exercises;
- `stellar:pubnet` is already defined upstream, so pubnet conformance is a
  configuration change rather than an upstream contribution.

## 2. How an external facilitator plugs in

`e2e/facilitators/external-proxies/` is the documented, supported place for a
facilitator whose implementation does not live in the x402 repository. Upstream
gitignores the directory, so **the component lives here and is copied in at run
time**. It is in [`e2e/accensa-proxy/`](../e2e/accensa-proxy).

Two mismatches have to be bridged, and both are declarations rather than changes
to the service:

| Harness expects | This service does | Bridge |
|---|---|---|
| the literal string `Facilitator listening` on stdout (case-sensitive, `src/proxy-base.ts`) | prints `x402 Stellar facilitator listening on :PORT` — lowercase `f`, so it misses | `run.sh` waits for readiness and then emits the expected line |
| health at `/health` | serves `/healthz` | `test.config.json` declares `endpoints: [{ "path": "/healthz", "health": true }]` |

**The proxy does not proxy.** It starts this service on the port the harness
assigns and gets out of the way, so the harness talks straight to our HTTP
surface. An adapter that reshaped requests or responses would make the entire
exercise worthless — the thing under test is the wire format.

### Accounts

Three distinct funded testnet accounts are required, and that is not stylistic:
`ExactStellarScheme` rejects any payment where the facilitator is a party to the
transfer, so payer, recipient and facilitator must be three different keys or
verification fails on the first request.

[`scripts/fund-testnet-accounts.mjs`](../scripts/fund-testnet-accounts.mjs)
generates and friendbot-funds them per run and prints them as env assignments.
Fresh accounts rather than repository secrets: three funded keys stored in CI
configuration forever, rotated by nobody, is a worse arrangement than generating
them for the ninety seconds they are needed. There is deliberately no pubnet
path in that script — friendbot does not exist there, and pubnet conformance is
a separate, deliberate operational step.

## 3. Running it

```bash
git clone --depth 1 https://github.com/x402-foundation/x402.git
cd x402/e2e

pnpm install:all          # NOT `pnpm install` — see the note below

mkdir -p facilitators/external-proxies/accensa
cp /path/to/x402-facilitator-stellar/e2e/accensa-proxy/* facilitators/external-proxies/accensa/

node /path/to/x402-facilitator-stellar/scripts/fund-testnet-accounts.mjs > .env
echo "ACCENSA_FACILITATOR_DIR=/path/to/x402-facilitator-stellar" >> .env

pnpm test --testnet --families=stellar --facilitators=accensa --min -v
```

> **`pnpm install` is not sufficient.** `install:all` is `pnpm install && ./setup.sh`,
> and `setup.sh` is what builds the workspace `@x402/*` packages the spawned
> servers import. With `pnpm install` alone the harness starts, selects scenarios
> and boots facilitators, then every server fails with
> `Cannot find module '@x402/express/dist/cjs/index.js'`. Node **22 or newer** is
> also required: the repo pins `pnpm@11.1.1`, which needs `node:sqlite`.

Selecting `--facilitators=accensa` runs only ours. Without it the harness also
starts its own reference facilitators, and a failure in one of those aborts the
run before ours is exercised — which is a property of the harness, not evidence
about this service.

## 4. Results

### 2026-08-14 — first payments settled on testnet; 1 of 5 server components passes

The previous section closed by saying this one would be written with the first
real result, pass or fail. It is both.

**Two runs, `71743e1` against upstream `main`, twelve minutes apart.** Each
settled exactly one payment on Stellar testnet, and each failed four scenarios.

#### What passed — and it is the headline claim of this repository

An **unmodified canonical client** (`typescript/http/fetch`) requested a
paywalled route, received a `402` with terms, signed a payment authorization,
retried, and this facilitator verified it and settled it on-chain. The fee was
paid by the facilitator's own account, so `areFeesSponsored` is not just
advertised in `/supported` — it is what happened.

| Run | Transaction | Ledger | Settled |
|---|---|---|---|
| 1 | [`5f1bd15a…5558`](https://stellar.expert/explorer/testnet/tx/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558) | 4134781 | 2026-08-14T08:15:33Z |
| 2 | [`ff798145…0590`](https://stellar.expert/explorer/testnet/tx/ff798145681ad66e20f39f60d91895e993bc8033bbc78847aa5ddf0ee1e70590) | 4134928 | 2026-08-14T08:27:49Z |

Both return `"successful": true` from Horizon. Check them yourself:

```bash
curl -s https://horizon-testnet.stellar.org/transactions/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558 \
  | jq '{successful, ledger, created_at}'
```

#### What failed — four of five, and it is structural

| Server component | Run 1 | Run 2 | Failure |
|---|---|---|---|
| `typescript/http/next` | ✅ (5th) | ✅ (3rd) | — |
| `typescript/http/express` | ❌ | ❌ | `Payment response header not found` |
| `typescript/http/fastify` | ❌ | ❌ | `Payment response header not found` |
| `typescript/http/hono` | ❌ | ❌ | `402 facilitator_error` |
| `typescript/mcp` | ❌ | ❌ | `402 facilitator_error` |

The two runs are reported together because the harness ordered the combinations
differently in each, and that difference is the only useful control available.
`next` passed from position 5 and again from position 3, while the same four
failed in both. **So this is not flakiness, not USDC propagation lag, and not
the treasury draining** — the first hypothesis after run 1 was that only the
last combination passed because the payer's balance needed time to propagate,
and run 2 disproves it.

Exactly one settlement occurs per run, so the four failures never reached the
chain at all. The one structural difference visible from outside is the route:
`next` is exercised at `/api/exact/stellar/withX402`, the other four at
`/exact/stellar` and `exact_stellar`.

#### Why this cannot be diagnosed further today

The facilitator produced **four lines of output across an entire run** — three
startup banners and an exit code:

```
[facilitators/external-proxies/accensa] stdout: x402 Stellar facilitator listening on :4027
[facilitators/external-proxies/accensa] stdout:   networks : stellar:testnet
[facilitators/external-proxies/accensa] stdout: Facilitator listening on :4027
[facilitators/external-proxies/accensa] Process exited with code 143
```

No request log, no verify or settle outcome, no rejection reason. Two of the
four failures return upstream's `facilitator_error`, which means *this service
returned an error* — and there is no record of what it was. Whether the other
two are ours or upstream's is likewise unknowable from here.

That made [#7](https://github.com/accensa/x402-facilitator-stellar/issues/7)
(structured logging, request correlation, `/metrics`) the blocking item for this
document, not a nice-to-have. It is tracked against these runs in
[#64](https://github.com/accensa/x402-facilitator-stellar/issues/64).

#### A Bazaar finding, on the passing scenario

```
[Catalog] Hard drop: invalid_routeTemplate
[x402] extension responses: {"bazaar":{"status":"rejected","code":"invalid_routeTemplate"}}
```

Upstream's server registers wildcard `*` route templates; this repo's catalog
validation hard-drops them. This is the **first time another party's client has
touched this catalog**, and the listing was rejected. Filed as
[#65](https://github.com/accensa/x402-facilitator-stellar/issues/65).

### 2026-08-25/26 — all five server components pass; the four failures are gone and diagnosable

**Two more runs, two consecutive nights: `10 of 10` scenarios pass, every server
component, with on-chain settlements.** This is the state that closes #64.

The harness had grown `upfront` variants of each route in the meantime, so the
scenario matrix is wider than the August 14 one — and the previously failing
`/exact/stellar` and `exact_stellar` combinations are the ones now passing:

| Server component | Scenarios | Result |
|---|---|---|
| `typescript/http/express` | `/exact/stellar`, `/exact/stellar/upfront` | ✅ ✅ |
| `typescript/http/fastify` | `/exact/stellar`, `/exact/stellar/upfront` | ✅ ✅ |
| `typescript/http/hono` | `/exact/stellar`, `/exact/stellar/upfront` | ✅ ✅ |
| `typescript/http/next` | `/api/exact/stellar/withX402`, `…/upfront/withx402` | ✅ ✅ |
| `typescript/mcp` | `exact_stellar`, `exact_stellar_upfront` | ✅ ✅ |

Every scenario reports a settled transaction hash; the ten from the 2026-08-26
run (`8c7ccfc`) are `69451e0c…`, `8f9d490c…`, `6502820d…`, `93d286b9…`,
`c51cccdd…`, `63535589…`, `c5fd4371…`, `991935c9…`, `8e59272f…`, `6b111ef8…`
— verifiable on Horizon the same way as the August 14 pair. `express`, `fastify`,
`hono` and `mcp` each settled two payments, on both the plain and `upfront`
payment flows.

#### Why the four failures were not seen on these runs, and what would show them next time

The run before the first green one (2026-08-24) still failed with all three
original signatures: upstream's `402 facilitator_error` (`mcp`), a 402 the client
could not parse (`hono`, `fastify`), and `Payment response header not found`
(`express`, `fastify`). The next merge to main — the request-validation and
structured-logging work from #238/#239/#240 — was the last change before the
suite went green, and it has stayed green since.

The facilitator now emits **one structured line per request** instead of four
lines per run, and the harness captures them, so a failure can be attributed to
a specific verify/settle call and its response — the exact capability #7 was
opened for. From the 2026-08-25 run:

```
[facilitators/external-proxies/accensa] stdout: {"method":"POST","path":"/verify","status":200,"durationMs":224,…}
[facilitators/external-proxies/accensa] stdout: {"method":"POST","path":"/settle","status":200,"durationMs":5236,…}
```

(`/verify` and `/settle` carried redacted headers only — the request logger never
touches `paymentPayload`/`paymentRequirements`, see `src/logger.js`.) The audit
channel and `/metrics` complete the picture: `settlement` audit records carry the
transaction hash and outcome, and `x402_signer_*` counters expose selection and
in-flight settlement at `/metrics`.

Neither the four failures nor the inability to see them have recurred since.
Whether the residual credit belongs to this repo's request-validation/logging
work or to upstream harness fixes is recorded rather than guessed: each run's
artifact pins the facilitator commit and the upstream SHA, so a regression can be
attributed the same way.

### 2026-08-12 — integration verified, payment path not yet exercised

Run locally against `x402-foundation/x402@main`, Stellar family, testnet.

**What is proven:**

| | |
|---|---|
| The harness discovers our facilitator as an external component | ✅ |
| It is selected into the scenario matrix (`facilitator(accensa-stellar-v2)`) | ✅ |
| It boots under the harness on an assigned port | ✅ |
| The ready-line bridge works | ✅ `Facilitator listening on :4027` |
| The harness health check passes | ✅ `Facilitator health check 1/10: ✅` |
| Five server/facilitator combinations are built against it | ✅ express, fastify, hono, next, mcp |

```
🏛️ Starting facilitator: accensa on port 4027
[facilitators/external-proxies/accensa] stdout: x402 Stellar facilitator listening on :4027
[facilitators/external-proxies/accensa] stdout: Facilitator listening on :4027
 🔍 Facilitator health check 1/10: ✅
  ✅ Facilitator accensa ready at http://localhost:4027

🔧 Server/Facilitator combinations: 5
   • typescript/http/express + accensa: 1 test(s)
   • typescript/mcp + accensa: 1 test(s)
   • typescript/http/next + accensa: 1 test(s)
   • typescript/http/hono + accensa: 1 test(s)
   • typescript/http/fastify + accensa: 1 test(s)
```

**What is not yet proven, and why.** No payment completed. The run stopped
before any scenario executed. Two causes, both in how the harness was invoked
rather than in this service:

1. `--facilitators=accensa` was omitted, so the harness also started its own
   reference facilitator, which died on a missing `@x402/aptos` and aborted the
   whole run before any of our scenarios executed.
2. `pnpm install` was used instead of `pnpm install:all`, so the upstream
   *servers* could not start either:

```
Error: Cannot find module '/…/e2e/servers/typescript/node_modules/@x402/express/dist/cjs/index.js'
[servers/typescript/http/express] Process exited with code 1 during startup
```

Both are invocation problems in the environment the harness was run in, not
findings about this facilitator. **They are recorded here rather than omitted**,
because a conformance document that lists only what passed is one that was not
looked at hard enough — and because the next person to run this will hit exactly
these two things.

So the honest statement today is: **this facilitator is accepted by the upstream
harness as a conforming external facilitator and passes its health gate; whether
an unmodified upstream client completes a payment against it is untested.** The
scheduled CI job exists to answer that, and this section will be updated with
its first result — pass or fail.

### Acceptance items

Current as of 2026-08-26.

| Item | State | Evidence |
|---|---|---|
| Canonical client completes a payment, testnet | ✅ | [`5f1bd15a…`](https://stellar.expert/explorer/testnet/tx/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558) and [`ff798145…`](https://stellar.expert/explorer/testnet/tx/ff798145681ad66e20f39f60d91895e993bc8033bbc78847aa5ddf0ee1e70590), both `successful` on Horizon |
| Canonical client completes a payment, pubnet | ⬜ | **pending funding, op-only step for #17** — the code path is verified at the config/facilitator layer (`test/pubnet-conformance.test.js`); the on-mainnet proof needs funded pubnet keys and a contracted RPC, which no CI secret can supply |
| `/supported` emits `extra.areFeesSponsored` | ✅ | `test/app.test.js`; and observed — the facilitator paid the fee on both settlements above; both-networks advertising pinned in `test/pubnet-conformance.test.js` |
| `payload: {transaction}` accepted verbatim | ✅ | `test/app.test.js` |
| Upstream e2e suite, testnet | ✅ | **5 of 5 server components pass — 10/10 scenarios, two consecutive runs (2026-08-25, 2026-08-26).** `express`, `fastify`, `hono`, `next`, `mcp` each settled both the plain and `upfront` flows. See above; tracked to resolution in #64 |
| Upstream e2e suite, pubnet | ⬜ | **pending funding, op-only step for #17** — same gating as the single-payment proof; no pubnet secret exists in this repo |
| Non-null reason on every rejection | ✅ | `test/app.test.js`, across four malformed-body shapes on both routes |
| Settled tx hash published per network per scheme | 🟡 | testnet `exact` published across twenty scenarios above; pubnet pending funding (op-only, #17). #18 |
| Bazaar listing accepted by a third-party client | ❌ | first attempt rejected `invalid_routeTemplate`, #65 |
| `__check_auth` smart-account payer | ⬜ | #13 |
| Structured logs sufficient to diagnose a failure | ✅ | one structured line per request with redacted headers (`src/logger.js`), `audit` channel records, `/metrics`; observed working in the harness output since 2026-08-25 |
| SEP-41 7-decimal amount handling, exact stroops | ✅ | `test/conformance-sep41-decimals.test.js` — 12 cases pinning exact stroop equality across boundary/truncation/rejection (#152) |
| Ledger-expiry and replay wire behaviour | ✅ | `test/conformance-expiry-replay.test.js` — expired payloads rejected with machine-readable reasons; identical replays served from the settlement store, never double-submitted (#159) |
| Verify/settle within interactive budget | ✅ | `test/conformance-resource-budget.test.js` — round-trip latency and bound measurements under §3.6's interactive budget; headroom recorded (#161) |

## 5. Automation

[`.github/workflows/conformance.yml`](../.github/workflows/conformance.yml) runs
this daily and on demand, separately from `ci.yml`.

Separate on purpose: the job depends on testnet, on friendbot and on a
third-party repository at whatever state its main branch is in today. Any of
those can be down without anything being wrong with this service, and a red
build nobody believes is worse than no build. It publishes the full output as an
artifact, records the upstream SHA it tested against, and fails loudly rather
than going quietly amber.

## 6. Reproducing this yourself

Everything above is reproducible from a clean clone with the commands in §3. The
only inputs are a network connection and Node 22+; the accounts fund themselves.
If you get a different result, that is a bug report worth filing — the README
says a conformance failure is the most useful contribution to this repo, and it
means it.

## 7. Post-grant maintenance commitment

This section is the stated commitment the SCF RFP §3.6 asks for: how spec and
`@x402/*` drift is tracked after the grant, what triggers a conformance re-run, how a
breaking upstream change is handled, and how long conformance is maintained. The
mechanism below is not aspirational — it is the drift-monitoring work tracked in
[#15](https://github.com/accensa/x402-facilitator-stellar/issues/15), whose
implementation (PR [#254](https://github.com/accensa/x402-facilitator-stellar/pull/254))
configures the automation and writes the reviewed-baseline policy this section commits
to.

### What is watched, and by what mechanism

Two distinct things drift, and they are watched by two mechanisms:

1. **The wire protocol and the `@x402/*` packages** (conformance). Renovate groups
   `@x402/*` into a single PR per release (they release together); the nightly
   conformance job
   (`.github/workflows/conformance.yml`, daily `0 6 * * *`, also `workflow_dispatch`)
   runs the upstream x402 e2e suite against our facilitator. The upstream SHA under
   test is recorded, and the last manually-reviewed SHA is held in `docs/UPSTREAM.md`
   so every diff is against a known baseline.
2. **Discovery / Bazaar conventions** (a separate obligation, §3.2). The Bazaar
   extension schema and the catalog filters come from `@x402/extensions`, which is in
   the same Renovate group — but the *conventions* (what the catalog must accept, how
   listing validation behaves) are judged by the same upstream suite plus the
   search-evaluation harness (`npm run eval`, run in CI). Convention drift is tracked
   in the same drift issue as wire drift, because the two surface through the same
   upgrade, but the response differs: a wire break fails the conformance job; a
   convention break fails the eval gate or the Bazaar conformance scenarios.

### Cadence and triggers

| Trigger | Action | Responsible | SLA |
| --- | --- | --- | --- |
| Nightly (daily) | Conformance run against `x402-foundation/x402@main` | CI, no human in the loop | Failure opens/updates a tracking issue with the run URL (workflow change tracked in [#192](https://github.com/accensa/x402-facilitator-stellar/issues/192)) |
| Weekly | Spec-drift job diffs tracked spec files against `docs/UPSTREAM.md` baseline; opens an issue on change | CI opens; a maintainer reviews within the week | Issue triaged within 5 working days |
| `@x402/*` bump PR | Conformance job runs against the PR; the PR is blocked on its failure | CI gate; maintainer merges or reverts | Before merge — a red conformance build never merges |
| Upstream release notice | Release notes / npm advisory | Maintainer review | Reviewed before the next scheduled run |

Ownership: the drift issue is assigned to a named maintainer at all times; an
unassigned alert is a log line, so the assignment is part of the mechanism, not an
afterthought.

### Breaking-change response

When an upstream change invalidates current behaviour (a renamed field, a tightened
validation rule, a new required header):

1. **Detect** — the nightly job or the bump-PR gate goes red and names the upstream
   SHA; the drift issue records it.
2. **Assess** — determine whether the break is wire-level (clients must change) or
   service-level (only we must change). Wire-level breaks are the ones that matter to
   integrators.
3. **Communicate** — sellers and agents already integrated are told through the drift
   issue, the release notes, and — for wire-level breaks — a
   `docs/CONFORMANCE.md` entry dated with the affected upstream SHA and the support
   window below. Integrators who do not read the issue tracker are reached via the
   dependency upgrade path: a grouped `@x402/*` bump carries the break, so anyone who
   upgrades gets the documentation with it.
4. **Adopt or hold** — adopt within the support window, or pin the previous `@x402/*`
   version for the remainder of the window while the break is worked. The pin is a
   documented, deliberate state, not a silent one.

### Maintenance horizon

Conformance is maintained for **24 months after the grant ends**, and the commitment
is bounded: after that horizon, this repository's conformance posture will be
re-assessed and stated explicitly rather than assumed. During the horizon:

- the nightly conformance job and the drift watch keep running on the published
  schedule;
- `@x402/*` bumps are adopted within the support window above;
- the protocol version this service speaks is supported for **one minor version back**
  from the latest `@x402/*` release, matching the upstream package's own support
  window.

A bounded commitment that will be kept is worth more than an unbounded one that will
not; the re-assessment at the horizon is part of the commitment, not a loophole.

### Where this is enforced

- `.github/workflows/conformance.yml` — the nightly run (and its failure notification,
  [#192](https://github.com/accensa/x402-facilitator-stellar/issues/192)).
- [#15](https://github.com/accensa/x402-facilitator-stellar/issues/15) — the
  drift-monitoring issue this section implements; PR
  [#254](https://github.com/accensa/x402-facilitator-stellar/pull/254) is its
  automation and policy.
- `docs/UPSTREAM.md` — the reviewed-baseline SHA and the full review policy (created
  by the drift-monitoring implementation).
