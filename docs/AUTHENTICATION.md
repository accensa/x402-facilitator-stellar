# Caller Authentication

The x402 facilitator provides a thin HTTP transport. Authentication in this service refers exclusively to **caller authentication** — identifying and authorizing the *resource server* (or its agent) that invokes the facilitator.

> **Note:** This is distinct from *buyer authentication*. Buyer authorization is verified from the cryptographic payment payload by the x402 scheme implementation.

## Trust Model

The facilitator operates as a sponsored fee-payer and transaction submitter on behalf of known, trusted resource servers.

## CORS

Cross-origin access is decided **per route class**:

| Route class | Default policy |
| --- | --- |
| Public reads | Any origin when `CORS_ALLOWED_ORIGINS` is unset; otherwise only allowlisted origins. |
| Authenticated | No origin is allowed by default; only explicitly allowlisted origins are reflected. |

Allowed origins are configured with `CORS_ALLOWED_ORIGINS` as a comma-separated list:

```bash
CORS_ALLOWED_ORIGINS=https://resource-server.example.com,https://dashboard.example.com
```

### Preflight cache duration

CORS preflight responses use a route-class-specific `Access-Control-Max-Age` value:

- Authenticated routes: 60 seconds by default.
- Public routes: 600 seconds by default.

This means a browser may continue using a cached preflight grant for up to 60 seconds after an authenticated allowlist change or up to 600 seconds after a public allowlist change.

Operators may override these values with `preflightMaxAgeSeconds` in the CORS configuration:

```js
preflightMaxAgeSeconds: {
  authenticated: 120,
  public: 900,
}
```

Only finite positive numbers are valid. Zero, negative values, `NaN`, infinity, strings, or missing policy overrides fall back to the documented authenticated/public defaults. The implementation never emits `NaN` or another invalid HTTP max-age value.

When `Vary` is already present, the CORS hook merges `Origin` and, when requested, `Accept-Encoding` into it without replacing existing tokens or adding duplicate case-insensitive tokens.
