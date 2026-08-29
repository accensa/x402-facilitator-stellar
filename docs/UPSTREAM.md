# Upstream Tracking & Spec-Drift Policy

This service is a **thin transport over `@x402/stellar`**. The hard parts —
`verify`, `settle`, `getExtra`, `getSigners`, and the validation inside
`ExactStellarScheme` — are deliberately *not* reimplemented here; they live
upstream. That choice makes us structurally dependent on upstream, so the cost
of getting it wrong moves from "we shipped a bug" to "upstream silently changed
a shape and our conformance degraded without telling us."

This document is the commitment that the drift is *watched*, not assumed away.
The automation below is the evidence that the policy is real.

<!-- upstream-baseline-sha: b1a88efb90f61e498ea1907971f4b0379a5673b8 -->
<!-- upstream:tracked-files:start -->
specs/schemes/exact/scheme_exact_stellar.md
specs/schemes/exact/scheme_exact.md
specs/extensions/bazaar.md
<!-- upstream:tracked-files:end -->

## What is tracked

We watch the canonical spec repository **`x402-foundation/x402`** (the source of
the `@x402/*` packages we depend on). Two independent mechanisms watch it:

1. **Dependency automation** — Renovate (`renovate.json`) opens version-bump PRs
   for `@x402/*`, `@stellar/*`, `express`, and `undici`, with the `@x402/*`
   packages grouped into a single PR because they release together.
2. **Spec-file drift** — a scheduled job (`.github/workflows/upstream-spec-watch.yml`)
   compares the spec documents we depend on against a known baseline and opens an
   issue when any of them change.

### Baseline

The commit SHA last reviewed is recorded in the `<!-- upstream-baseline-sha: … -->`
marker above (`b1a88efb90f61e498ea1907971f4b0379a5673b8` at time of writing).
Every drift check is a diff **against this exact commit**, so a clean run means
"nothing we depend on changed since we last looked," not "nothing changed this
week." Updating the baseline is a *human* act of review (below), never done by
the bot — auto-bumping it would make the watch report green by construction.

### Tracked spec files

The files listed in the tracked-files block above (between the
`upstream:tracked-files` markers) are the
minimum we depend on:

- `specs/schemes/exact/scheme_exact_stellar.md` — the Stellar `exact` scheme
  definition: auth-entry structure, expiration rules, facilitator-safety and
  sub-invocation constraints, and the "exactly one transfer event" rule that
  `ExactStellarScheme` enforces.
- `specs/schemes/exact/scheme_exact.md` — the base `exact` scheme; Stellar's
  network-specific rules are defined relative to it, so a change here can change
  what our facilitator must accept.
- `specs/extensions/bazaar.md` — the discovery extension (`EXTENSION-RESPONSES`,
  `GET /discovery/resources`, `GET /discovery/search` envelope). Our catalog and
  MCP server implement this; a shape change there is a conformance break on the
  discovery path even though it does not touch `verify`/`settle`.

The list is plain text between the markers and is edited in the normal way when
we start depending on a new spec file.

## Review policy

### How quickly we adopt a new `@x402/*` minor

- **Patch (`2.x.y` → `2.x.y+1`)**: adopt within **48 hours**. These are
  bug/security fixes and the grouped Renovate PR is merged once the conformance
  gate (below) is green. No separate review issue is required.
- **Minor (`2.x` → `2.x+1`)**: adopt within **1 week** of release. The grouped
  Renovate PR is opened automatically; a maintainer reads the upstream changelog
  and the spec-drift issue (if any) before merging. The conformance gate must be
  green. If the minor changed a tracked spec file, the baseline in this document
  is updated as part of the same PR.
- **Major (`2` → `3`)**: **not auto-merged**. Opens an issue, is discussed, and
  gets its own branch + a conformance run before anything on `main` moves. A
  major bump is, by definition, a breaking upstream change (see below).

We do **not** pin to an exact version or sit on old minors: sitting still is how
drift becomes a quarter-long surprise. Adopting promptly is what keeps the
grouped version set coherent.

### Who reviews spec changes

- The **spec-drift issue** opened by `upstream-spec-watch.yml` is assigned to the
  maintainer on triage rotation (currently the CODEOWNERS of `src/` and
  `docs/UPSTREAM.md`).
- A **second reviewer** (any other code owner) is required before the baseline
  SHA in this file is advanced, so "I skimmed it" is never the only check on a
  shape change we ship against.
- The **conformance gate failing** on a `@x402/*` bump PR is itself a review
  signal: it means upstream changed something our transport no longer satisfies,
  and the PR is blocked until the failure is understood — not until it is green.

### How a breaking upstream change is communicated to integrators

A breaking change is one that alters a wire shape, a validation rule, a filter
name, or a scheme definition our clients depend on. The path:

1. The drift job (or a red conformance run on a bump PR) is the **first signal**.
2. A GitHub issue is opened (or updated) labelled **`breaking-upstream-change`**,
   cross-linked from the drift/spec issue, stating: what changed upstream, the
   commit, the before/after shape, and the migration step for integrators.
3. The change is **pinned in `README.md`** under a "Upstream breaking changes"
   heading for the support window (below), and announced in the repo's
   Discussions/release notes.
4. If the break affects the discovery/`EXTENSION-RESPONSES` contract, the MCP
   server and catalog consumers are notified via the same issue, because those
   are the integrators most exposed to a silent envelope change.

The principle: integrators learn from an issue + a README pin, not from a 500 in
production.

### Support window for a previous protocol version

- We support the **current adopted `@x402/*` minor and the immediately preceding
  minor** for **90 days** after a new minor is adopted.
- A **major version** is supported for **6 months** after the next major is
  adopted, or until an announced end-of-life date — whichever is later. EOL is
  posted in the same `breaking-upstream-change` issue and pinned in the README.
- During the window, clients on the older version keep working; we do not drop
  support for a version a known integrator still uses without first contacting
  them through the breaking-change path above.

## How the automation works (so it can be trusted)

- `upstream-spec-watch.yml` runs **weekly (Monday 06:17 UTC)** and on manual
  dispatch. For each tracked file it asks the GitHub API for the blob SHA at
  `main` and at the baseline commit; if they differ, it records the change. If
  any file changed, it opens (or comments on) a single open issue labelled
  `upstream-spec-drift` with per-file diffs and the suggested new baseline SHA.
  It deliberately does **not** advance the baseline — that is the human review
  step, recorded above.
- `conformance-on-bump.yml` runs when Renovate opens a PR that changes
  `@x402/*` in `package.json`/`package-lock.json`. It diffs the PR against its
  base, and if a `@x402/*` version moved, it calls the conformance workflow
  (`.github/workflows/conformance.yml`) against the PR head. That run needs
  testnet + the `TESTNET_USDC_TREASURY_SECRET` secret, which is why we use
  **Renovate** (in-repo branches) rather than Dependabot — Renovate PRs are
  ordinary in-repo PRs and CI can read repo secrets, so a breaking bump fails the
  PR instead of being deferred.
- Branch protection on `main` makes **`upstream e2e (stellar, testnet)`** a
  required status check, so a `@x402/*` bump that breaks conformance cannot be
  merged. (Configure in repo Settings → Branches; this file is the policy, the
  setting is the enforcement.)

## Review cadence (summary)

| Cadence | Mechanism | Action on signal |
|---|---|---|
| Weekly | `upstream-spec-watch.yml` | Open/comment `upstream-spec-drift` issue; human reviews and advances baseline |
| On every `@x402/*` bump PR | `conformance-on-bump.yml` → conformance run | Block PR on conformance failure; review upstream changelog |
| On merge of a spec-changing bump | maintainer | Advance `upstream-baseline-sha` in this file, same PR |
| Ad-hoc | `workflow_dispatch` on either workflow | Manual re-check / re-run |
