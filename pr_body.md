## Summary

This PR implements three fixes for reported issues:

### Issue #677 - CORS Vary header merge

**Problem:** The CORS hook wrote `reply.header('Vary', 'Origin')` which replaced any existing Vary value. When `@fastify/compress` added `Vary: Accept-Encoding` on compressed responses, it erased the `Origin` token, causing shared caches to key responses by the wrong origin and browsers to block cross-origin calls.

**Solution:** Append `Origin` to the existing Vary header instead of replacing it, normalizing tokens case-insensitively and deduplicating while preserving token order. Uses `reply.getHeader('Vary')` which may return a string or array, normalizing both.

**Files changed:**
- `src/cors.js` - Updated the Vary header logic in `createCorsHook` (lines 115-127), added per-policy default max-age and `resolvePreflightMaxAge` helper

### Issue #678 - Preflight grants outlive allowlist change by 24 hours

**Problem:** A single constant `PREFLIGHT_MAX_AGE = '86400'` (24 hours) was used for all route classes. Browsers cache the preflight result including `Access-Control-Allow-Origin` for that window. Removing an origin from `CORS_ALLOWED_ORIGINS` takes effect server-side immediately but not in browsers holding preflight answers, keeping revoked origins serving for up to a day.

**Solution:** Changed to per-policy max-age defaults: 60s for authenticated routes (quick revocation) and 600s for public routes (longer cache for discovery reads). Added `resolvePreflightMaxAge()` function that accepts `corsConfig.preflightMaxAgeSeconds` overrides, with invalid values clamped to safe finite numbers (never NaN).

**Files changed:**
- `src/cors.js` - Replaced `PREFLIGHT_MAX_AGE` constant with `DEFAULT_PREFLIGHT_MAX_AGE` object and `resolvePreflightMaxAge()` function; updated `createPreflightHandler` to use per-policy max-age

### Issue #679 - Concurrent cold JWT requests each build a new JWKS set and refetch

**Problem:** `verifyToken` checked the module-level TTL cache; on miss it built a new remote JWKS set. Each instance started with its own empty key cache, so a burst of concurrent requests created one instance per request and fetched JWKS once per instance. If the IdP rate-limited, valid tokens turned into 401s.

**Solution:** Single-flight the JWKS construction per URI behind one in-flight promise at module scope. On a cache miss, the first call creates the promise, subsequent calls await it. On completion (success or failure), the in-flight entry is deleted so the next call retries. Failed constructions do not cache rejections.

**Files changed:**
- `src/auth-http.js` - Added `jwksInFlight` map at module scope (line 43-44); modified `createJwtVerifier`'s `verifyToken` to single-flight JWKS construction and clean up in `finally`

**Test files created:**
- `test/cors-vary-merge.test.js` - Tests for Vary header merge behavior
- `test/cors-preflight-max-age.test.js` - Tests for per-policy preflight max-age
- `test/auth-http-jwks-singleflight.test.js` - Tests for JWT JWKS single-flight

**All four CI gates pass:** lint, format:check, test, env:check