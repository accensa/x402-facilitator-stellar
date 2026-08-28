# Tracker triage — duplicate issues

Status of the duplicate-issue sweep tracked by [#149](https://github.com/accensa/x402-facilitator-stellar/issues/149).
Last reviewed: 2026-08-26, against all 125 open issues then in the tracker.

## Method

Every open issue was reviewed for duplication against every other open issue and against
the work already merged to `main`. Review was done in two passes:

1. **Title similarity sweep** over all open issues (token Jaccard threshold 0.30),
   followed by full-body reads of every pair the sweep surfaced.
2. **Manual review** of the thematic clusters where titles differ but the underlying
   work could overlap: rate limiting, error handling, catalog integrity, MCP protocol
   handling, Docker/ops, CI, and documentation.

## Result

**Zero duplicates remain among open issues.**

The literal duplicate pairs named in #149 were all closed by an earlier pass:

Survivor chains were verified against the actual closing comments — some survivors
have themselves since been completed:

| Closed as duplicate | Survivor (status) |
|---|---|
| #73 structured JSON logging | #7 (open) |
| #74 Prometheus metrics endpoint | #7 (open) |
| #75 health check endpoint | #8 (open) |
| #77 graceful shutdown handling | #8 (open) |
| #79 OpenAPI/Swagger documentation | #71 (completed) |
| #80 request ID tracking | #7 (open) |
| #81 payload validation schema | #99 → #68 (completed) |
| #82 configure HTTP timeout | #8 (open) |
| #83 gzip compression middleware | #69 (open) |
| #89 request payload size limit | implemented: `express.json({ limit: '256kb' })` in `src/app.js` |
| #93 Redis-based rate limiting | #122 (completed) |
| #96 structured JSON logger (Pino) | #7 (open) |
| #97 Prometheus metrics endpoint | #7 (open) |
| #98 graceful shutdown | #8 (open) |
| #99 payload validation with Zod | #68 (completed) |
| #101 request correlation IDs | #7 (open) |
| #106 CORS configuration management | #76 (completed) |
| #108 request payload size limits | implemented: `express.json({ limit: '256kb' })` in `src/app.js` |
| #112 automated OpenAPI docs | #71 (completed) |

A further nine short issues (#84–#103 range) were closed as *already implemented* with
pointers to the code (#84 rate limiting, #85 Dockerfile, #87 admin auth, #88 test suite,
#90 CI pipeline, #91 lint/format, #92 env validation, #102 API-key middleware,
#103 config caching), not as duplicates.

## Judgment calls — reviewed and deliberately kept separate

These pairs scored high on title similarity but describe distinct work after reading
the bodies. Closing either would lose real scope:

- **#166 vs #182** — both make the daily fee ceiling ineffective, but via two
  independent root causes in different code paths (#166: recorded fee is always 0
  because `SettleResponse` has no `transactionFeeStroops`; #182: `checkSettle` passes
  `amount = 0` so the crossing transaction is always allowed). Both fixes are needed;
  fixing one leaves the ceiling broken.
- **#185 vs #223** — the same class of bug at two distinct sites
  (`scoreResource`/`last_seen_at` vs `listResources`/`first_seen_at`); #223 already
  cross-references #185.
- **#236 vs #151** — #236 is input validation of the resource URL scheme (XSS/SSRF);
  #151 is proof of ownership of a listing (spoofing prevention). Complementary, not
  overlapping.
- **#175 vs #172** — same bare-`Number()` pattern in different modules
  (`config.js` spend ceiling/port vs rate-limit overrides) with different failure modes.
- **#205 vs #8** — process-level boot/rejection handlers vs graceful shutdown draining.
- **#202 vs #146** — bounding the `EXTENSION-RESPONSES` header size vs documenting it.
- **#199 vs #198** — two distinct JSON-RPC protocol violations.

## Complexity tags

Survivors of every closed pair carry honest tags. Where a pair disagreed (e.g. the
trivial-tagged short issue folded into a medium-tagged bundle), the survivor's tag was
confirmed against the actual scope: #7 and #8 each bundle three related features at
`complexity: medium`, which is fair for their combined surface.

## Ongoing rule

Before filing an ops/facilitator feature issue, search the tracker for the bundled
issues **#6–#10**, which already cover logging/correlation/metrics, shutdown/readiness,
rate limiting/metering, signer pooling and durable settlement state.
