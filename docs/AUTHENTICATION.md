# Caller Authentication

The x402 facilitator provides a thin HTTP transport. Authentication in this service refers exclusively to **caller authentication** — identifying and authorizing the *resource server* (or its agent) making the HTTP request.

> **Note:** This is distinct from *buyer authentication*. The buyer is authenticated via the cryptographic signature on their `Authorization` entry on-chain. That verification is performed by the upstream `@x402/stellar` package and is transparent to this transport layer.

## Trust Model

The facilitator operates as a sponsored fee-payer and transaction submitter on behalf of known, trusted resource servers.

- **`/supported` and `/healthz`**: These routes are completely open by design. `/supported` is a discovery endpoint that clients must be able to read before establishing any relationship with the service.
- **`/verify` and `/settle`**: These routes sponsor transaction fees and consume resources. They require a valid API key (unless running in open mode on testnet).

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

## Open Mode

If `FACILITATOR_API_KEYS` is unset or empty, the facilitator runs in **open mode**.
This means all routes are unauthenticated. The server logs a loud warning at boot when running in this mode.

Open mode is acceptable (and often desired) for **public testnet deployments** to allow frictionless developer onboarding. It is strongly discouraged on pubnet, where unauthenticated callers can drain the signer's funds by submitting valid but abusive transactions.

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
