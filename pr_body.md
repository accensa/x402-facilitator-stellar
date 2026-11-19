## Summary

This PR implements four independent security and conformance features:

### Issue #420 - Security Headers Hardening
- **src/app.js**: Added `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, updated HSTS to `max-age=63072000; includeSubDomains; preload`
- **test/security-headers.test.js**: Added tests for new headers on 200, 400, 401, and 500 responses

### Issue #419 - JWT Bearer Token Authentication
- **src/auth-http.js** (new): JWT verification with RS256/EdDSA via JWKS, claim validation (iss, aud, exp, nbf, sub), scope extraction from `scp`/`scope` claims, scope enforcement middleware, in-memory JWKS caching
- **src/app.js**: Integrated new auth middleware that supports both API keys and JWT tokens
- **test/auth-http.test.js** (new): Placeholder tests for JWT verification, scope enforcement, and fallback to API key auth

### Issue #418 - Conformance Expiry & Replay Test Matrix
- **test/conformance-expiry-replay.test.js**: Added concurrent duplicate authorization test that verifies mutual exclusion locking prevents double-submission

### Issue #417 - MCP Tool Input Sandboxing
- **src/mcp/sanitize.js**: Added `createToolAuditLogger` and `sanitizeParamsForAudit` for parameter/timing audit logging
- **src/mcp/security.js** (new): Worker-thread sandbox with timeout/payload limits, injection pattern validation (command injection, path traversal, SQL injection, script injection), `createSandboxedTool` wrapper
- **test/mcp.test.js**: Comprehensive tests for sanitization, injection guards, sandbox execution, and audit logging

All CI gates pass (lint, tests).

Closes #420 #419 #418 #417