## What changed

This PR merges CORS `Vary` values instead of replacing them, applies route-class-specific preflight cache durations, and single-flights cold JWKS resolver construction per URI.

## Why

Closes #677

Closes #678

Closes #679

## How it was verified

- [ ] `npm test`
- [ ] `npx eslint .`
- [ ] `npx prettier --check .`
- [ ] `npm run env:check`

## Wire format

- [ ] Yes — preflight responses now send `Access-Control-Max-Age: 60` for authenticated routes and `600` for public routes instead of the previous `86400` seconds. CORS `Vary` is also merged and may include `Accept-Encoding`.
- [ ] No

## Anything a reviewer should push back on

The JWKS cache is intentionally process-local and keyed by URI. The in-flight entry is removed after success or failure, and failed construction is retryable. CORS overrides accept only finite positive numbers; invalid values fall back to 60/600 seconds.

### Tests added

- CORS `Vary` merge and case-insensitive deduplication.
- Per-policy preflight max-age and invalid overrides.
- Concurrent and retrying JWKS resolver behavior using a local JWKS endpoint.
