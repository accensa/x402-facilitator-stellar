# Business Model, Metering & Rate Limiting

This document is the SCF RFP §3.1 deliverable: the **business model and design choices for caller authentication, metering, and rate limiting**, presented as one coherent design. It is deliberately kept in the repository — §4 grades what can be verified, and the mechanisms it describes are the ones `src/config.js`, `src/rate-limit.js`, `src/app.js` and the docs in this directory actually implement.

The four parts answer four questions about the same caller:

| Concern | File / route | Answer |
|---|---|---|
| **Authentication** — *who is calling?* | API keys on `/verify`, `/settle`, `/usage`, `POST /discovery/resources` | `docs/AUTHENTICATION.md`. Identity is an API key; no key means open mode. |
| **Metering** — *how much have they used?* | `GET /usage` | Counters per key: `verify_rpm`, `settle_rpm`, `settle_rph`, `settle_rpd`, `fee_spd`. |
| **Rate limiting** — *how much may they use?* | sliding-window checks on the same routes | `docs/OPERATIONS.md`. Defaults: 60 verify/min, 10 settle/min, 100/hr, 1000/day, 5,000,000 stroops sponsored fee/day, 10 catalog writes/min. |
| **Business model** — *why does any of this exist and who pays?* | This document | Testnet free and operator-funded; mainnet pricing operator-configurable, with the daily sponsored-fee ceiling as the loss bound. |

## Business Model

**What is free.** Everything on testnet. Open mode (no `FACILITATOR_API_KEYS`) is the correct default there: no caller registration, sponsored network fees, and frictionless onboarding — the sub-hour path §3.6 grades. The Bazaar read routes (`GET /discovery/resources`, `GET /discovery/search`, `/supported`, `/healthz`) are free and unauthenticated on every network by design, because an agent must be able to discover a resource before it has any relationship with the facilitator.

**What is paid.** Nothing — today. There is no billing implementation, and that is deliberate: this is a conformance spike, and §3.1 asks for the business model to be *documented*, not for billing to be built. The design commits to a model, and the metering that would underpin billing already exists:

- **Testnet:** the operator funds everything (see sponsorship solvency below). This is the public onboarding surface, and charging for it would contradict the RFP's developer-onboarding goals.
- **Mainnet:** pricing is **operator-configurable** rather than hard-coded. The operator decides what to charge for — a per-settlement commission, a subscription, or nothing (subsidized) — and can enforce consequences through the existing knobs: per-key rate-limit overrides (`RATE_LIMIT_<keyId>`) and the per-key daily fee ceiling. The service itself never collects money from buyers; it sponsors fees and settles, and the seller's `payTo` receives the payment.

**Who pays.** On testnet, the operator pays for sponsored network fees; buyers pay only the payment asset (that is the point of `areFeesSponsored`). On mainnet at volume, someone must fund the XLM the facilitator spends per settlement — see solvency below. Sellers pay nothing to the facilitator to be listed; cataloguing is free and automatic off the payment path.

## Non-Custodial Guarantee

The facilitator is **non-custodial by construction**: it never holds a buyer's or seller's assets, never takes custody of the payment amount, and has no path to spend anything but its own XLM on network fees. Its signer accounts exist only to sponsor fees and submit the payer's authorized invocation; the actual transfer goes from the buyer's account to the seller's `payTo` address, and the upstream `ExactStellarScheme` rejects any transaction in which the facilitator is a party to the transfer. Buyers need only the payment asset — no XLM for fees — because the facilitator pays the network fee. `GET /supported` advertises this as `areFeesSponsored: true`.

## Sponsorship Solvency at Volume

Sponsored fees cost the operator real XLM per settlement. Three mechanisms make that spend bounded and visible rather than open-ended:

1. **Per-transaction cap.** `MAX_TX_FEE_STROOPS` (default 50,000 = 0.005 XLM) bounds what one settlement may cost the operator; the scheme refuses a transaction whose simulated fee exceeds it.
2. **Per-caller daily fee ceiling.** `fee_spd` (default 5,000,000 stroops = 0.5 XLM/day) bounds the operator's worst-case sponsored spend per caller per day. This is the number that actually matters on pubnet: it caps loss even if a caller settles at the per-transaction maximum every time, and it survives restarts when the rate-limit store is shared (Postgres/Redis — `docs/OPERATIONS.md` "Rate Limit Store").
3. **Solvency monitoring.** `GET /readyz` fails readiness (503) when any signer account is below `READINESS_FUNDING_FLOOR_STROOPS` — the operator is told before the pool runs dry, not after. An optional fee-bump account can concentrate fee payment in one funded account (`docs/OPERATIONS.md` "Multi-Signer Pool Management").

At volume the operator funds sponsorship from the revenue side of whatever mainnet pricing they configure (commission, subscription, subsidy). The metering below is what makes that revenue measurable; the rate limits above are what make the cost of the worst case a fixed, knowable number.

## Caller Authentication

Full detail in `docs/AUTHENTICATION.md`; the design decisions relevant here:

- **API keys identify the caller.** `FACILITATOR_API_KEYS` is a comma-separated `name:secret` list, hashed at boot, verified constant-time. The key's `keyId` is what metering and rate limiting key on.
- **Unset keys = open mode**, correct for public testnet and strongly discouraged on pubnet, where an unauthenticated caller can drain the signer by submitting valid-but-abusive transactions. The server logs a loud warning when running open.
- **Two route classes, two policies.** Public reads (`/supported`, `GET /discovery/resources`, `GET /discovery/search`, `/healthz`) are open on every network — a catalog no one can read unauthenticated is useless to agents. Everything that spends money or writes the catalog (`/verify`, `/settle`, `/usage`, `POST /discovery/resources`, `/settlements/:idempotencyKey`) requires a key (or is open-mode testnet).
- **`/usage` refuses open mode with a distinct reason** (`open_mode_usage_forbidden`). This is a deliberate design decision: usage accounting has no meaning for an anonymous caller, and keying "usage" by IP would both misattribute and leak per-IP activity. Metering requires identity.

## Metering Design

`GET /usage` returns the calling key's own counters for the current windows: `verify_rpm`, `settle_rpm`, `settle_rph`, `settle_rpd`, and `fee_spd` — exactly the limit families, so a caller can see how close to each ceiling they are and back off before a 429.

**Why meter at all:** three purposes, in increasing order of importance.

1. **Caller transparency** — an agent that is about to hit a ceiling can see it coming (the `RateLimit-*` headers on every response already carry the same numbers for the current request).
2. **Capacity and abuse signal** — a key climbing toward its daily ceilings is either a healthy power user or scripted abuse; the audit log records rate-limit rejections so the operator can tell which.
3. **The raw material for billing** — if an operator enables mainnet pricing, `fee_spd` is exactly the "how much did this caller cost me" number, and `settle_*` is the "how much value did they get" number. Billing is out of scope for this spike, but the measurement that would feed it is not an afterthought; it is the same counters the limiter already maintains.

Metering and rate limiting share one store (`src/rate-limit.js` + `src/rate-limit-store.js`): a check reads without consuming, a successful request records, and the daily fee ceiling is *checked* before settlement and *recorded* after, so the operator's exposure is bounded even under a sustained burst.

## Rate Limiting

Defaults (per caller, configurable globally and per key via `RATE_LIMIT_GLOBAL` / `RATE_LIMIT_<keyId>`):

| Limit | Default | Why |
|---|---|---|
| `verify_rpm` | 60/min | Verification is CPU-light and spends no money, so the limit is about bounding scripted load, not cost. 60/min is generous for a legitimate seller and stops a tight abuse loop. |
| `settle_rpm` | 10/min | Settlement touches the chain and spends the operator's XLM. The per-minute bound absorbs the natural burst of an agent batch while capping the damage a tight loop can do. |
| `settle_rph` | 100/hr | The hour window smooths the burst into a sustainable average. |
| `settle_rpd` | 1000/day | The total. Agent payment traffic is bursty by nature; a day window is the longest horizon that still limits a runaway caller within a calendar day. |
| `fee_spd` | 5,000,000 stroops/day | The sponsored-fee ceiling — the operator's worst-case cost per caller per day (0.5 XLM at current prices). This is the loss bound that matters on pubnet; at the default per-tx fee cap it allows ~100 max-fee settlements or tens of thousands of typical ones. |
| `catalog_rpm` | 10/min | Catalog writes are cheap but poisonable (a flooded catalog is a poisoned discovery layer), and a `payTo` is already capped at 50 listings. 10/min bounds upsert floods. |

**Deliberate gap — the discovery read routes are not rate-limited.** `GET /discovery/resources` and `GET /discovery/search` are public catalog reads that any agent must be able to hit; they are intentionally outside the limiter today. They are also outside authentication, so an unauthenticated client can issue unlimited read traffic. That is a known, accepted exposure for the spike (the read path is cheap, in-memory, and p95-budgeted under 50ms), and it is tracked as [#135](https://github.com/accensa/x402-facilitator-stellar/issues/135) rather than silently accepted. The catalog *write* path (`POST /discovery/resources` and payment-path cataloguing) is limited by `catalog_rpm`.

**Why these numbers and not others.** They encode three priorities: (1) testnet onboarding must never feel rate-limited to a legitimate developer (hence generous testnet defaults and open mode); (2) the operator's sponsored-fee exposure must be *bounded*, not merely discouraged (hence `fee_spd` as a hard ceiling, not a soft signal); (3) abuse must be visible (every rejection is audited with the caller and the reason). The numbers are operator-tunable precisely because they encode cost decisions — a mainnet operator who charges per settlement may set a higher ceiling; one who wants tighter loss control sets a lower one.

## The Design as One Whole

Authentication, metering, rate limiting and the business model are the same loop, not four features:

1. **Authentication** establishes *who* — the `keyId` (or, in open mode, the source IP) attached to every request.
2. **Metering** records *how much they have done* — the counters that make behaviour observable and, later, billable.
3. **Rate limiting** enforces *how much they may do* — the ceilings that keep a runaway caller from costing the operator money or degrading the service.
4. **The business model** explains *why the operator runs any of it* — a free testnet onboarding surface whose costs are bounded by the same ceilings, and a mainnet surface where the operator decides what to charge, using the meters this design already keeps.

A mainnet operator reviewing this repository can answer three questions without touching code: who is calling (keys), how much each caller has cost them (`/usage`), and what the worst case is (the ceilings). That is what §3.1 asks to be documented.

## Out of Scope

Implementing billing. This document states the model, the meters and the ceilings; wiring `fee_spd` into invoices is a deliberate follow-up, and the design above is what makes that follow-up possible without re-architecture.
