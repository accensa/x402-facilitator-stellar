- closes #236
- closes #234
- closes #233
- closes #228

### Description of Changes

This pull request addresses the following four issues with targeted, minimal changes exactly as defined by the project's strict MVP constraints:

**1. Constrain URL Scheme of Catalogued Resources (#236)**
- **What changed:** Added explicit URL protocol validation to `src/catalog/validation.js` inside `validatePolicy`.
- **Why it was needed:** Previously, there was no check guaranteeing a resource URL's scheme was valid for network operations, potentially allowing arbitrary schemes like `file://` into the catalog. 
- **Impact:** Resources with schemes other than `http:` or `https:` will now be strictly hard-dropped at admission. Also updated `docs/BAZAAR.md` to document the new `invalid_url` and `invalid_url_scheme` rejection codes, ensuring `extension-responses-doc.test.js` passes.

**2. Count Degrading RPC Endpoints in Metrics (#234)**
- **What changed:** Added the missing `host` label to the `x402_rpc_retries_total` Prometheus Counter inside `src/metrics.js` and modified `incRpcRetry` and `installRpcRetry` integration in `src/server.js` to emit the `host` dimension.
- **Why it was needed:** The `x402_rpc_retries_total` metric was logging retries by error code, but aggregated all hosts together. This masked degrading endpoints, making it impossible to single out a failing connection versus normal noise.
- **Impact:** Operators can now group retry rates by `host` and detect specific degrading RPC endpoints. Updated `docs/OPERATIONS.md` to reflect the new `host` label.

**3. Wire MCP CLI HTTP Calls with the Retry Wrapper (#233)**
- **What changed:** Imported and initialized `installRpcRetry` directly inside `src/mcp/cli.js`.
- **Why it was needed:** The MCP CLI tool was executing direct fetch requests without utilizing the connection-level circuit breaker and backoff retry logic that guards the rest of the project.
- **Impact:** HTTP calls initiated by the MCP tool now appropriately follow the standard retry limits and thresholds installed onto `globalThis.fetch`.

**4. Introduce Schema Versioning to the Catalog Table (#228)**
- **What changed:** Added a `schema_version INTEGER NOT NULL DEFAULT 1` column to the `catalog_resources` table schema in `src/catalog/postgres.js`. Extended `_ensureSchema`, `hydrateRow` and `_persistResource` to respect and propagate this field.
- **Why it was needed:** The durable PostgreSQL catalog store had no versioning logic, preventing safe schema migrations and backward compatibility as the data shape evolves.
- **Impact:** Catalog entries now carry `schema_version`. Also gracefully updates existing databases with the `ALTER TABLE` statement in `_ensureSchema`.

### Testing and CI
- Validated via `npm test`, successfully passing catalog and validation tests.
- Successfully ran `cargo fmt`, `cargo clippy`, and `cargo test` on the Rust smart-contract fixtures.
