# Caller Authentication

The x402 facilitator provides a thin HTTP transport. Authentication in this service refers exclusively to **caller authentication** — identifying and authorizing the *resource server* (or its agent) making the HTTP request.

> **Note:** This is distinct from *buyer authentication*. The buyer is authenticated via the cryptographic signature on their `Authorization` entry on-chain. That verification is performed by the upstream `@x402/stellar` package and is transparent to this transport layer.

## Trust Model

The facilitator operates as a sponsored fee-payer and transaction submitter on behalf of known, trusted resource servers.

Everything else in this document is the route inventory: what is authenticated, what is not, and why.

## Route Inventory

This table is the authoritative answer to "what is authenticated here". It is audited against `src/app.js` route by route, and the audit is enforced by `test/docs-routes.test.js` — adding a route to the app without updating this table fails the test suite, so the next omission is a CI failure rather than a documentation drift.

| Route | Authentication | Rate limited | Open mode (no API keys configured) | Why |
| --- | --- | --- | --- | --- |
| `GET /healthz` | none | no | open | Liveness probe; answers `{ ok: true }` while the process runs. |
| `GET /readyz` | none | no | open | Readiness probe; names the failing dependency per network when unhealthy. |
| `GET /metrics` | none | no | open | Prometheus text exposition for the operator; no caller data. |
| `GET /supported` | none | no | open **by design** | Discovery endpoint: clients must read it before establishing any relationship with the service, so it cannot be gated behind a key they do not have yet. |
| `GET /discovery/resources` | none | no¹ | open **by design** | Catalog read: agents and sellers browse the Bazaar before they hold a key. |
| `GET /discovery/search` | none | no¹ | open **by design** | Catalog search — same rationale as the listing read, but the more expensive of the two. |
| `POST /discovery/resources` | API key | yes (catalog bucket) | open | Catalog write: creates or overwrites a public listing, so it is metered and audited. |
| `POST /verify` | API key | yes (verify bucket) | open | Sponsors verification work; consumes resources, so it is metered. |
| `POST /settle` | API key | yes (settle bucket) | open | Sponsors transaction fees; the expensive, money-moving route, so it is metered and audited. |
| `GET /settlements/:idempotencyKey` | API key | no | open | Settlement status read, scoped to the caller's `keyId`. |
| `GET /settlements/:idempotencyKey/events` | API key | no | open | Ordered event history for one settlement (#130) — the audit trail behind the status read, scoped to the caller's `keyId`. |
| `GET /usage` | API key — **strict** | n/a (reads the meter) | **refused** | The one route that refuses open mode: it exists to meter authenticated callers, and with no keys there is nothing to meter. Returns `401` with reason `open_mode_usage_forbidden`. |
| `OPTIONS <cors-enabled route>` | none | no | open | CORS preflight; cannot carry an API key, so it is answered before credentials matter. |
| anything else | n/a | n/a | n/a | `404` with reason `route_not_found`. |

¹ The discovery read routes are **unauthenticated and unmetered today**. Whether reads should be rate limited — and whether they stay open at all — is tracked in [#135](https://github.com/accensa/x402-facilitator-stellar/issues/135). If that issue only adds metering, the posture here stays "unauthenticated but metered"; if it changes authentication, this table changes with it.

### Open mode means "open, except /usage"

When `FACILITATOR_API_KEYS` is unset or empty, the facilitator runs in **open mode**: every route above that says "open" is truly unauthenticated, and the server logs a loud warning at boot.

The one deliberate refusal is `GET /usage`, which requires `requireApiKeyStrict` — stricter than the `requireApiKey` used everywhere else. In open mode it answers `401` with reason `open_mode_usage_forbidden` instead of serving a meter nobody is metered against.

Open mode is acceptable (and often desired) for **public testnet deployments** to allow frictionless developer onboarding. It is strongly discouraged on pubnet, where unauthenticated callers can drain the signer's funds by submitting valid but abusive transactions.

## Configuring API Keys

Keys are configured via the `FACILITATOR_API_KEYS` environment variable as a comma-separated list.

**Format:**
`FACILITATOR_API_KEYS=name1:secret1,name2:secret2`

If a name is omitted (e.g., `FACILITATOR_API_KEYS=secret1,secret2`), keys will be auto-named (e.g., `key_0`, `key_1`). The name (`keyId`) is attached to request contexts for metering and rate-limiting.

**Security properties:**
- Keys are resolved at boot time and their SHA-256 digests are held in memory.
- Plaintext keys are **never** logged.
- The `Authorization` header is verified using constant-time string comparison (`crypto.timingSafeEqual`) to prevent timing attacks.

## Rotation and Revocation

Currently, key revocation requires a process restart. To rotate or revoke a key:
1. Update the `FACILITATOR_API_KEYS` environment variable.
2. Restart the facilitator process.

Because the system doesn't rely on stateful sessions, any in-flight requests using a revoked key that haven't passed the authentication middleware yet will be rejected with a `401 Unauthorized`.

## Making Requests

A caller authenticates by providing a key in the HTTP `Authorization` header. Two formats are supported:

- `Authorization: Bearer <secret>`
- `Authorization: <secret>`

Malformed headers or unrecognized keys will return a `401 Unauthorized` with a distinct `reason` code (e.g., `invalid_api_key`, `missing_auth_header`, `malformed_auth_header`).

## CORS

Cross-origin access is decided **per route class**, because the two classes carry opposite risk:

| Route class | Routes | Default policy |
| --- | --- | --- |
| Public reads | `GET /supported`, `GET /discovery/resources`, `GET /discovery/search` (and `/healthz`) | Any origin. These are unauthenticated and carry no credential worth protecting — a browser-based agent or catalog explorer needs them. |
| Authenticated | `POST /verify`, `POST /settle`, `GET /usage`, `GET /settlements/:idempotencyKey`, `POST /discovery/resources` | **No grant by default.** These routes carry an API key; a permissive policy would let any web page send a caller's key somewhere it should not go. |

Allowed origins for the authenticated class are configured via `CORS_ALLOWED_ORIGINS` as a comma-separated list:

```
CORS_ALLOWED_ORIGINS=https://resource-server.example.com,https://dashboard.example.com
```

When set, the list also narrows the public reads to exactly those origins instead of `*`.

Notes:

- `Authorization` is not a CORS-safelisted request header, so every browser call to `/verify` or `/settle` triggers a preflight (`OPTIONS`). The preflight is answered with `Authorization` and `Content-Type` in `Access-Control-Allow-Headers`; without a grant the browser blocks the actual request.
- `RateLimit-*`, `Retry-After` and `EXTENSION-RESPONSES` are named in `Access-Control-Expose-Headers`, so rate-limit state and the Bazaar cataloguing outcome are readable from browser JavaScript.
- `/healthz`, `/readyz` and `/metrics` carry no CORS configuration at all: they are operator endpoints, not browser surfaces.
