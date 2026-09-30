- closes #218
- closes #374
- closes #386
- closes #388

## #218 — description truncation could split a surrogate pair and emit invalid UTF-16

`validatePolicy` cut descriptions with `description.substring(0, 200)`, which cuts on
UTF-16 code-unit boundaries. A description whose 200th code unit was the **high half of
an astral character** (an emoji in a listing blurb) therefore reached the catalog with an
unpaired surrogate attached. That is not valid UTF-16: `JSON.stringify` serialises it as a
lone `\udXXX` escape, conformant clients render it as U+FFFD, and the value cannot be
round-tripped through a `jsonb` column — the write is either rejected or stored as
something the seller never sent.

`truncateDescription()` walks back one code unit when the cut lands on a high surrogate,
dropping the straddled character whole. It is a no-op fast path when the description
already fits, so a normal listing pays nothing for the guard. The `description_truncated`
soft drop, the 200-unit limit, and every other policy outcome are unchanged.

```js
const boundary = value.charCodeAt(maxLength - 1);
const end = boundary >= 0xd800 && boundary <= 0xdbff ? maxLength - 1 : maxLength;
return value.slice(0, end);
```

Tests (`test/catalog.validation.test.js`, "Description truncation is surrogate-safe
(#218)") pin the four positions a cut can land in — inside the pair, immediately after it,
on the plain ASCII boundary, and emoji-only — and assert of every emitted description that
it contains no unpaired surrogate, survives `JSON.parse(JSON.stringify(x))`, and survives
a UTF-8 write/read. `CHANGELOG.md` records it, because a client can observe the value.

## #374 — catalog.search.test.js had no explicit failure modes

The store deliberately assumes an API-validated boundary, which is exactly why
`store.search()` with no arguments throws a bare `TypeError` today, and why a bad `limit`
silently mis-slices (`slice(0, -1)` drops the last result) instead of failing. Nothing in
the search suite named those states, so a caller could not tell "the store is broken" from
"I called it wrong".

The suite now carries the same shape the validation suite already uses:

- `CatalogSearchError` — typed failure with a stable `code`, the `params` that caused it
  and the original `cause`.
- `SEARCH_ERROR_CODES` — `invalid_search_params`, `invalid_search_query`,
  `invalid_search_limit`, `search_store_failed`, `malformed_search_response`.
- `safeSearch(store, params, { logger })` — validates arguments *before* the store is
  reached, wraps any throw with the cause preserved, refuses a response that is not
  `{ resources: [], pagination: {} }` with a message naming the missing piece, and logs
  exactly one structured diagnostic per failure (success logs nothing).
- `searchWithFallback(...)` — returns a `degradedSearchPage()` (`degraded: true`,
  `reason`, empty `resources`, terminal cursor) so a caller that must answer can serve an
  honest empty page. A failure that is *not* a `CatalogSearchError` is re-thrown rather
  than hidden behind that page.

Every error state is asserted, including that a rejected call never reaches the store,
that the message names the offending value, and that the raw `store.search()` TypeError
this issue is about is absorbed into a well-formed page.

## #386 — exhaustive unit tests for mcp.test.js, with the error surface enforced

`test/mcp.test.js` spawned the real CLI for everything, so its "coverage" of the client
was whatever the real CLI happened to do: the spawn-failure test asserted `assert.ok(true)`
and its own comment admitted it "might not fail as expected on all platforms". The client
now lives in `test/helpers/mcp-client.js` (the pattern #370 set for the search suite) and
is tested at three levels:

1. **Primitives** — `LineFramer` and `BoundedCapture` in isolation.
2. **Over a real pipe** — against `test/fixtures/mcp/scripted-cli.js`, a scripted peer that
   can answer normally, answer with a JSON-RPC error, print non-JSON noise, reply one byte
   at a time, stay silent, or die mid-request.
3. **Through an injected `spawn`** — for the failures a real child cannot be made to
   produce on demand and which were previously untested: a spawn that throws, a child
   `error` event, a stdin write whose callback fails, a stdin write that throws, and a kill
   that throws. These are synchronous and deterministic, so there is no timing luck left.

The CLI's spending controls are also covered end to end against a mock 402 server — per-call
cap, session budget, `maxFeeStroops`, an unpaid 200 passthrough, a 402 with no `accepts`, a
402 that is not a payment-required response, and the missing-payer-key refusal. Every case
refuses *before* signing, so the suite stays offline: no funded account, no testnet. The
settled-payment path needs real testnet settlement and stays in the conformance workflow
(`npm run e2e`); that limit is stated in the file's testing-strategy comment rather than
papered over.

Coverage is enforced structurally by `MCP_CLIENT_ERROR_CODES` plus a final test that
asserts the set of codes this file produced equals the declared list — so adding a code,
or deleting the test that produces one, fails the run. Node's test runner excludes `test/`
from `--experimental-test-coverage`, which is why the guard is used instead of a percentage
that would read 100.00% for an empty report.

## #388 — fewer allocations and less overhead in the client, with benchmarks

Three targets, each with a metric:

| Target | Before | After |
| --- | --- | --- |
| stdout framing | `buffer += chunk; buffer.split('\n')` per read: one line array per read and a re-split + re-copy of the whole undelivered tail | `LineFramer`: one scan per read, the tail kept as slices and joined once when its line ends |
| stderr capture | every chunk retained for the process lifetime, re-concatenated on each error path | `BoundedCapture`: first 64 KiB retained, the rest counted without copying, `text()` memoised |
| teardown | a referenced 5 s SIGKILL timer on every `close()`, holding the event loop open | timer is `unref`'d and cleared on child exit; grace period configurable |

Measured by the suite itself, which prints its numbers:

- one 256 KiB tool result on a single line, delivered in 1 KiB reads: the old reader
  re-scans **129x the input** and takes 32.26 ms; the framer takes 0.39 ms (ratio 0.012).
  The re-scan factor is asserted deterministically (it cannot flake); the time ratio is
  asserted at `< 0.5`, a 40x margin.
- a burst of 200 small results: re-scan 2x the input (bounded by the line length, which is
  why wall-clock is reported but not asserted for that shape).
- `BoundedCapture` fed 8 MiB: **1024 B retained vs 8388608 B unbounded (8192x)**, asserted.
- a closed client adds no referenced timer, asserted via `process.getActiveResourcesInfo()`.

Framing output is asserted byte-identical to the loop it replaced (including CRLF,
blank lines, and messages split across reads), so the optimisation is provably
function-preserving.

## How it was verified

| Gate | Result |
| --- | --- |
| `npx eslint .` | clean |
| `npx prettier --check` (LF-normalised copy of each changed file) | clean |
| `node --test test/catalog.search.test.js test/catalog.validation.test.js test/mcp.test.js` | 82 / 82 pass |
| `npm test` (run in four file groups) | 1017 / 1020 pass |
| `git status` | only the files listed below are touched |

The three failures are pre-existing and **environment-only** on this Windows checkout; none
of them is in a file this PR touches, and neither reproduces on Linux CI:

- `test/dockerfile.test.js` ×2 — the test splits the Dockerfile on `\n` and then compares a
  destination token, so the `\r` of a CRLF checkout makes `./scripts/` compare unequal to
  `scripts/`. Verified directly: the same function returns `false false` for the checked-out
  CRLF file and `true true` for its LF form, which is what CI reads.
- `test/process-handlers.test.js` — "server.js reports a bind failure and exits non-zero
  instead of dying silently" (the failure already recorded as pre-existing and unrelated in
  `pr_body.md` from #446); the spawned server boots normally and the assertion that times
  out concerns process exit semantics on Windows.

## Wire format

**Yes, and it is described here.** #218 changes a value a client can observe: a
`description` longer than 200 code units that previously came back with a lone surrogate
now comes back one code unit shorter and valid. The field name, the 200-unit limit and the
`description_truncated` soft-drop reason are unchanged; no route, status code or response
shape changes. #374/#386/#388 are test-only.

## Notes for the reviewer

- The issue templates ask for `PRD.md`, `ARCHITECTURE.md`, `ARCHITECTURE_ESSENTIALS.md`,
  `ROADMAP.md`, `AGENTS.md`/`CLAUDE.md` and for `cargo check` / `cargo clippy` /
  `cargo test` to pass. None of those files exists in this repository, and this is a Node
  service, so the constraints that do exist — `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`,
  `docs/CONFORMANCE.md` — were used, and the equivalent gates above were run instead. There
  is no `ROADMAP.md` box to tick; nothing was invented to make one.
- Scope was kept to the four issues: no production code changed except the #218 truncation
  (#374/#386/#388 are confined to `test/`), and no dependency was added.
