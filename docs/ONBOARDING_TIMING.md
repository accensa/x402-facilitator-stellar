# Onboarding Timing: "Under an Hour to a Paid, Discoverable Endpoint"

Issue #155. The SCF RFP
([§3.6](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track#x402-facilitator-with-bazaar-discovery-support-1))
sets a specific, measurable bar: *"developers should reach paid, discoverable
endpoints in under an hour."* This document is the measurement instrument for
that claim. It records the exact protocol, the finish line, the per-step timing
template, and the publication format — for a developer going from an **empty
directory** to a **settled payment** against their own seller endpoint that is
**returned by discovery search**.

> 🟨 **Current status: protocol published, cold run not yet recorded.**
> Getting an honest number requires the measurement to be run *cold* — by
> someone who has not built this repository, on a clean machine, following only
> the published docs. This file deliberately leaves the timing table unfilled
> so the recorded numbers are a real measurement, not an assertion. When you run
> it, fill the table below and open a PR. The bar is the finding, whatever it is.

## 1. The finish line (must be exactly this)

A walkthrough is **complete only when both hold**:

1. A payment has **settled** against the developer's own seller endpoint
   (transaction hash verifiable on the Stellar testnet explorer).
2. That endpoint is returned by `GET /discovery/search` (the Bazaar catalog).

Anything less — a seller endpoint that takes x402 requests but has never
settled, or one that is paid but not discoverable — is **not** the §3.6 bar and
does not count. Time stops at the later of the two.

## 2. Protocol (how to run it, so the number is comparable)

1. **Clean machine.** A fresh checkout, empty `node_modules`, no cached
   credentials, no environment variables pre-set. Do not reuse a prior `.env`.
2. **Follow only published docs.** Use the [docs hub](README.md) and the
   role-based guides ([Seller](SELLER.md) · [Buyer/Agent](BUYER.md) ·
   [Operator](OPERATOR.md)). Do **not** use internal knowledge.
3. **Timed wall-clock from first command.** Start the clock on the first shell
   command (typically `git clone`). Do not stop it for "thinking time" — dead
   ends, doc hunting and failed attempts count, and are the point.
4. **Record per step** in the table below, including failed attempts and the
   reason. The dead ends are the finding.
5. **Record the environment** so the run is reproducible: OS, Node version, git
   commit of `main`, RPC endpoint, and any testnet state (Friendbot funding
   availability affects setup time).

## 3. Step checklist & timing template

Time each row; mark `─` where a row was skipped. Total these rows = the headline
number for the proposal.

| # | Step | Time | Dead end / note |
|---|------|------|-----------------|
| 1 | `git clone` + `npm install` | | |
| 2 | `npm run lint` + `npm test` pass on a clean machine | | |
| 3 | Create + fund a testnet account (`npm run fund:testnet`) | | e.g. Friendbot throttle |
| 4 | Establish USDC trustline(s) (covered by `fund:testnet`) | | |
| 5 | Obtain testnet USDC on the payer (`npm run prepare:testnet-usdc`) | | treasury secret absent → `usdc_ready=false` |
| 6 | Configure the facilitator (`.env`, `FACILITATOR_SECRET`, RPC) | | |
| 7 | Start the facilitator; `/healthz` + `/readyz` green | | |
| 8 | Wire the seller integration (e.g. `examples/http-seller`) | | |
| 9 | Run a canonical client through a full **settled** payment | | |
| 10 | Confirm settled tx hash on the testnet explorer | | |
| 11 | Attach the discovery listing / register the endpoint | | |
| 12 | Confirm `GET /discovery/search` returns the endpoint | | |
| 13 | `npm run lint` passes on the setup artifacts you committed | | |
| 14 | `npm test` (`node --test`) passes | | |
| **TOTAL** | **→** | | |

### Known dead ends to expect (from the issue and repo history)

These are the documented places where the hour is likely to be consumed; record
each occurrence rather than working around it silently:

- **Friendbot throttling** on account funding (retry backoff) → Step 3.
- **Treasury secret absent** — `prepare:testnet-usdc` honestly reports
  `usdc_ready=false` and the USDC funding must be skipped → Step 5.
- **Trustline auth** — an account cannot hold issued USDC until it has
  authorized the issuer; the most common first-payment failure → Step 4/9.
- **Bazaar route-template validation** — upstream wildcard `*` route templates
  are hard-dropped as `invalid_routeTemplate`
  ([#65](https://github.com/accensa/x402-facilitator-stellar/issues/65)) → Step 12.

## 4. Publication format (when you record a run)

Open a PR that:

- Fills the timing table above and states an honest **TOTAL**.
- Reports the finish line was met (settled tx hash + a `discovery/search` hit),
  or says plainly that it was not met and lists the top consumers.
- Lists the follow-up issues filed for the largest time consumers (see below).
- If the measured total exceeds an hour, stay honest in the PR description
  rather than optimizing the *report* to fit the claim; the remediation follows
  from the measurements, not the other way round.

## 5. Filing follow-ups

The issue expects follow-up issues for the biggest costs. Candidates already
visible today:

- Wire the testnet setup scripts into `README.md`/`package.json` so a cold
  reader finds `npm run fund:testnet` and `npm run prepare:testnet-usdc`
  (this is already partially done — verify during Step 3/5).
- A time-boxed "document the USDC treasury prerequisite" follow-up so `usdc_ready`
  is never a silently skipped step.
- Friendbot-backoff guidance for Step 3.

File one issue per top time consumer with the measured time as evidence, then
re-run the cold walkthrough after the remediations to evidence the improvement
rather than assuming it. This file belongs to the same conformance wave as
[docs/CONFORMANCE.md](CONFORMANCE.md).