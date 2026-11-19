## What changed

Three transport fixes, confined to the CORS helpers and the JWT JWKS cache:

- **#677 — `Vary` is merged, not replaced.** `src/cors.js` gains a small `appendVary(reply, token)` helper. It splits the existing `Vary` value (string or array; array entries may themselves hold a comma-separated list), deduplicates tokens case-insensitively, preserves the first spelling and token order, then appends `Origin`. The `Accept-Encoding` token `@fastify/compress` writes afterwards therefore survives. The grant and credentials rules are untouched.
- **#678 — preflight max-age is per route class.** `PREFLIGHT_MAX_AGE = '86400'` becomes `DEFAULT_PREFLIGHT_MAX_AGE` (`authenticated: 300`, `public: 600`), resolved by a new `resolvePreflightMaxAge()`. An operator embedding the app may override either class with `cors.preflightMaxAgeSeconds`; anything that is not a finite number greater than zero falls back to the class default, so `NaN` can never reach the header. No new environment variable.
- **#679 — JWKS construction is single-flighted.** A module-level `jwksInFlight` map keyed by JWKS URI shares one construction per cold burst, and a `finally` clears the entry when the attempt settles, so a rejected construction is not cached. The resolver is taken from the awaited promise rather than a second cache lookup, which could miss if other cold URIs evicted the entry before the continuation ran.

## Why

Closes #677
Closes #678
Closes #679

- Replacing `Vary` with `Origin` erased the compression token. A shared cache could then key a compressed cross-origin response without `Origin` and replay the representation built for one origin to another.
- A single 24h preflight window meant a removed `CORS_ALLOWED_ORIGINS` origin stayed usable in a browser for up to a day: the server stopped granting it immediately, the browser's cached answer did not.
- Cold bursts at the TTL boundary had no explicit construction sharing, and a failed attempt had no settle-time cleanup.

## Wire format

Yes — one observable header changes:

| Request | Before | After |
| --- | --- | --- |
| `OPTIONS /verify`, `OPTIONS /settle`, … | `Access-Control-Max-Age: 86400` | `300` |
| `OPTIONS /supported`, discovery reads | `Access-Control-Max-Age: 86400` | `600` |
| Compressed cross-origin `GET` | `Vary: Origin` **or** `Vary: Accept-Encoding`, whichever wrote last | `Vary: Origin, accept-encoding` (one token each) |
| Uncompressed cross-origin `GET` | `Vary: Origin` | `Vary: Origin` |

Status `204`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` and `Access-Control-Expose-Headers` are unchanged, as are routes, bodies, reason codes and `openapi.yaml`.

## How it was verified

On this commit:

- `npm test` — **1764 tests, 1764 pass, 0 fail, 0 cancelled, 10 skipped**.
- `npx eslint .` — no findings.
- `npx prettier --check .` — all matched files formatted.
- `npm run env:check` — OK.

This run also fixes the three failing tests from CI job 135605681750:

1. `test/app.test.js › CORS preflight › public routes answer * when no allowlist is configured` — asserted the old `86400`; the public class is now `600`.
2. `test/cors.test.js › CORS: merchant domain patterns (#414) › preflight caches for 24h …` — asserted the old `86400`; the authenticated class is now `300`.
3. `test/cors-vary-merge.test.js › compressed cross-origin responses …` — the hook was adding its own `Accept-Encoding` on top of the one `@fastify/compress` appends, producing `Origin, Accept-Encoding, accept-encoding`. The hook now owns only `Origin` and the test compares tokens case-insensitively.

The three `cancelledByParent` entries in that run were the rest of the Vary suite being torn down after test 1 threw before `close()`; every test now closes in a `finally`.

Measured evidence:

- Ten concurrent cold `verifyToken` calls against a counting JWKS server: **1 request** with this branch. The same measurement against `main` is also 1, because the resolver is cached synchronously before any await and `jose` deduplicates its own fetch; the in-flight map makes that sharing explicit, per-URI and rejection-safe. The new regression tests report the request count directly.
- A JWKS endpoint that returns 503 once: first call rejects, the next retries and succeeds (2 requests total).

New tests: `test/cors-vary-merge.test.js` (merge, case-insensitive dedupe, array values, repeated calls, compressed response), `test/cors-preflight-max-age.test.js` (defaults and invalid overrides), `test/auth-http-jwks-singleflight.test.js` (cold burst, rejected construction, 503 retry). `test/app.test.js`, `test/cors.test.js` and `test/app-modular-helpers.test.js` were updated only where the intentional wire change or the hook's new `getHeader` read requires it.

## Anything a reviewer should push back on

- **Nothing was removed from `src/auth-http.js`.** `createAuthMiddlewareWithJwt`, `createJwtVerifier` and `verifyAndExtractScopes` are all still exported and `src/app.js` resolves them; the diff versus `main` touches only the construction block inside `createJwtVerifier`. The same holds for `src/cors.js`: `compileOriginPatterns`, `originMatches`, `createCorsHook` and `createPreflightHandler` are intact, with their documentation restored, and the diff contains no deletions outside the two intended hunks.
- **#679 barely changes the observable fetch count.** Measured 1 before / 1 after for a cold burst, for the reason above. If the bar is "the burst test must fail on `main`", it does not; the value here is that the sharing is explicit and keyed by URI, and that a rejected construction is provably not cached.
- **Public reads keep `600`** rather than returning to `86400`. The security issue is a preflight grant outliving an allowlist change, which applies to public reads too once an allowlist is configured. If you prefer 24h for public reads it is a one-line change to the constant.
- **Incidental flake fix:** `test/monitoring-probes.test.js` injected a 20ms delay and asserted `latencyMs >= 20`, which floors to 19ms on a loaded runner and failed two CI runs. The fixture is 60ms now and the assertion `>= 40`; the warn/no-incident behavior it checks is unchanged. Revert this hunk if you would rather keep the PR to the three issues.
