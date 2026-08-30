# HTTP Surface Audit (Issue #143)

A systematic pass over this service's own HTTP behaviour, exercised from OUTSIDE
the process with a real client. Every request below crossed the network boundary
(a `fetch` to an ephemeral listener built from `src/app.js`) rather than going
through an in-process test helper. The assertions that pin these behaviours to
the wire live in `test/http-surface-audit.test.js`.

The house rule stands: verify/settle semantics live upstream in `@x402/stellar`.
This audit records what *this service* does on the wire; where a defect is
upstream it is marked and stopped.

## Route inventory

| Method | Route | Auth | Rate-limited | Response shape |
|---|---|---|---|---|
| GET | `/healthz` | none | no | `{ ok: true }` |
| GET | `/readyz` | none | no | readiness report, `503` when unconfigured |
| GET | `/supported` | none (public) | no | `{ kinds, extensions, signers }` |
| GET | `/metrics` | none | no | Prometheus text (`text/plain`) |
| GET | `/usage` | strict API key | no | usage meter for the key |
| POST | `/verify` | API key (or open) | yes | `{ isValid, invalidReason, invalidMessage }` |
| POST | `/settle` | API key (or open) | yes | `{ success, errorReason, transaction, network }` |
| GET | `/settlements/:idempotencyKey` | API key | no | `{ ok, settlement }` or `404` |
| GET | `/settlements/:idempotencyKey/events` | API key | no | `{ ok, idempotencyKey, events }` or `404` |
| POST | `/discovery/resources` | API key | yes (catalog write) | `{ ok, resource, softDrops }` or `400` |
| GET | `/discovery/resources` | none (public) | yes (catalog read) | `{ x402Version, items, pagination }` |
| GET | `/discovery/search` | none (public) | yes (catalog read) | `{ x402Version, resources, partialResults, pagination }` |
| OPTIONS | all of the above | none (preflight) | no | `204` |
| * | unknown | — | — | `404 { error: not_found, reason: route_not_found }` |

## Findings

Legend for verdict: **FIXED** (changed in this PR), **DEFERRED** (recorded as a
follow-up issue, left in code), **OK** (behaviour is correct as observed).

| # | Route | Input | Expected | Observed | Verdict |
|---|---|---|---|---|---|
| F1 | `/verify`, `/settle`, POST `/discovery/resources` | malformed JSON body | `400` with reason `malformed_json`, JSON body, no HTML, no stack trace | `400` + JSON, but reason was `internal_error` (Fastify 5 renames the parser error to `FST_ERR_CTP_INVALID_JSON_BODY`, which the error handler did not match) | **FIXED** — `src/app.js` now matches `_BODY` (and keeps the legacy code); test pinned in `errors.test.js` + `http-surface-audit.test.js` |
| F2 | `/verify` (automatic cataloguing) | malformed/throws Bazaar discovery extension | every cataloguing outcome surfaced via `EXTENSION-RESPONSES` | `processCataloging` throw was swallowed; header omitted entirely — caller left with no cataloguing outcome | **FIXED** — `src/app.js` writes a `{ status: 'not attempted' }` fallback header in the catch; pinned in `http-surface-audit.test.js` |
| F3 | GET `/discovery/search` | `limit`/`offset` | pagination clamped and reported like `/discovery/resources` | `pagination` returns `{ limit, cursor }` only — no `offset`/`total`; cursor offset is governed entirely by the catalog, not clamped at the boundary | DEFERRED — [#295](https://github.com/accensa/x402-facilitator-stellar/issues/295) |
| F4 | `/verify`, `/settle` | unsupported media type (e.g. `application/x-www-form-urlencoded`) | a documented `unsupported_media_type` reason | `415` but reason `internal_error`; no dedicated code | DEFERRED — [#296](https://github.com/accensa/x402-facilitator-stellar/issues/296) |
| F5 | `/verify` (and `/settle`) | consecutive allowed requests | `RateLimit-Remaining` reflects requests actually consumed (not off by one) | Verified with the real limiter: 99 → 98 → … → 95 across five requests (limit 100) | **OK** — hypothesis from reading the code not reproduced; `_check` already accounts for the in-flight request |
| F6 | GET `/discovery/resources`, GET `/discovery/search` | reads at ceiling | discovery reads inside the limiter | Both call `checkCatalogRead` and return `429` with `Retry-After` + reason when refused | **OK** — hypothesis not reproduced; both reads are inside the limiter |
| F7 | GET `/discovery/resources` | `limit=500&offset=-5` | clamp to max 100 / min 0 | `{ limit: 100, offset: 0 }` | OK |
| F8 | GET `/discovery/resources` | `limit=abc` (non-numeric) | fall back to defaults | `{ limit: 20, offset: 0 }` | OK |
| F9 | GET `/discovery/resources` | duplicated query params (`limit=1&limit=500`) | tolerated, no error | `200`; Fastify coalesces to `limit: 1` | OK |
| F10 | GET `/discovery/resources` / `/search` | unicode + injection-shaped filters (`' OR 1=1--`, `<script>`, CJK) | empty result, no injection, no error | `200` empty result (in-memory catalog, no SQL/HTML sink) | OK |
| F11 | any unknown route | `GET /does-not-exist` | `404` JSON with a reason | `404 { error: not_found, reason: route_not_found }`, `application/json` | OK |
| F12 | any payment route | `OPTIONS` preflight | `204` + CORS allow headers | `204`, `Access-Control-Allow-Headers` includes `content-type` | OK |
| F13 | `GET /supported` (public) | browser `Origin` | `Access-Control-Expose-Headers` exposes read-worthy headers | Exposes `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`, `EXTENSION-RESPONSES` | OK |
| F14 | `GET /usage` | no API key, keyed instance | `401`, not `500` | `401 invalid_api_key` / `missing_auth_header`; `open_mode_usage_forbidden` in open mode | OK |
| F15 | GET `/readyz` | readiness unconfigured | `503 not_ready`, not a hang | `503 { ok:false, status:'not_ready', reason:'readiness_not_configured' }` | OK |
| F16 | POST `/verify`, `/settle` | oversized body > 256kb | `413 payload_too_large` | `413 payload_too_large` | OK |

## EXTENSION-RESPONSES envelope (all four cataloguing outcomes, decoded)

The header must base64-decode to `{ bazaar: { status, ... } }` in every
cataloguing outcome. Verified over real HTTP (see
`test/http-surface-audit.test.js`).

| Outcome | Decoded envelope | Reached by |
|---|---|---|
| landed | `{ "bazaar": { "status": "landed", "code": "catalog_success" } }` | valid discovery extension, no soft drops |
| partially landed | `{ "bazaar": { "status": "partially landed", "code": "catalog_partial", "reason": "Dropped fields: …" } }` | valid extension with one or more soft-dropped fields (e.g. bad `iconUrl`) |
| rejected | `{ "bazaar": { "status": "rejected", "code": "catalog_rate_limited" | "invalid_routeTemplate" | … } }` | hard drop (hostile routeTemplate, invalid schema) or catalog write rate-limited |
| not attempted | `{ "bazaar": { "status": "not attempted" } }` | no discovery extension, or (post-F2) a malformed extension that previously dropped the header |

## Headers, per route

- **`RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`**: set on
  `/verify`, `/settle`, POST `/discovery/resources`, GET `/discovery/resources`,
  GET `/discovery/search` (supplied by the limiter via `handleRateLimit`). Not
  set on public non-limited reads (`/supported`, `/healthz`, `/readyz`,
  `/metrics`). Verified across consecutive `/verify` calls (F5).
- **`Retry-After`**: set with a positive second count on every `429`
  (`handleRateLimit` when not allowed). Verified on `/verify`, `/settle` and the
  discovery reads.
- **`EXTENSION-RESPONSES`**: set on the `/verify` (automatic) and `/settle`
  cataloguing paths; always base64 of `{ bazaar: outcome }`. Now guaranteed
  present even when cataloguing parsing throws (F2).
- **`Content-Type`**: `application/json` on every JSON route (incl. all 4xx /
  5xx error bodies), `text/plain` on `/metrics`. Verified across the route
  matrix (headers test).

## Fixed here (one-liners)

- **F1** — `src/app.js` error boundary: accept `FST_ERR_CTP_INVALID_JSON_BODY`
  (Fastify 5) in addition to `FST_ERR_CTP_INVALID_JSON`, so malformed JSON keeps
  the documented `malformed_json` reason instead of `internal_error`.
- **F2** — `src/app.js` `processCataloging`: on an unhandled error, write a
  `not attempted` `EXTENSION-RESPONSES` fallback header so the seller is never
  left without their cataloguing outcome (cataloguing still never fails the
  payment).

## Deferred (follow-up issues)

- **F3** — `/discovery/search` pagination shape mismatch and boundary non-enforcement
  → [#295](https://github.com/accensa/x402-facilitator-stellar/issues/295).
- **F4** — no `unsupported_media_type` reason code on 415 media-type rejections
  → [#296](https://github.com/accensa/x402-facilitator-stellar/issues/296).

## Current test status

- `npm run lint` — passes.
- `npm test` — passes (includes `test/http-surface-audit.test.js`, 42 subtests).
- `npm run e2e` — requires live, funded Stellar testnet accounts
  (`ALICE_SECRET`/`FACILITATOR_SECRET`) and a running facilitator; blocked on
  credentials in this environment, unchanged by this audit (no HTTP surface
  behaviour was altered — only a reason-code fix and a header-guarantee fix).
