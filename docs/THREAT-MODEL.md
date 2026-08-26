# Threat Model

This document outlines the threat model for the X402 Facilitator, organized by asset. 
A key distinction is drawn between controls implemented in this repository ("Ours") and those provided by the upstream `@x402/stellar` package ("Upstream").

| Asset | Threats | Control | Ownership | Residual Risk |
|---|---|---|---|---|
| **Facilitator signing keys** | Theft at rest, in transit, in logs, in memory; blast radius; rotation | Keys are loaded via environment variables; never logged; rotation requires restart. | Ours | Memory extraction if the host is compromised. Blast radius limited to the fee budget. |
| **Sponsored fee budget** | Drain via unmetered settlement; fee-ceiling misconfiguration | `MAX_TX_FEE_STROOPS` ceiling per settlement. Rate limiting to prevent rapid drain. | Ours | Because fee metering conservatively charges the ceiling (Option B) rather than the actual fee, a distributed attack can drain the budget up to the rate limit, and legitimate usage may exhaust the daily budget faster than necessary due to over-counting. |
| **Settlement integrity** | Replay, double-settlement, redirected recipient, amount tampering | `ExactStellarScheme` validates signature, expiration, absence of sub-invocations, and simulates exact transfer. | Upstream | Upstream bug could allow malformed auth entries to pass. |
| **Catalog integrity** | Poisoning, traversal, impersonation | Strict route-template validation and sanitization. | Ours | Edge cases in URI parsing might bypass sanitization. |
| **Caller credentials** | Key leakage, timing attacks, missing rotation | API keys passed via headers; constant-time comparison; the request logger redacts Authorization/cookie/`*_secret` before logging (`src/logger.js`), and request bodies are never logged. | Ours | Stolen API keys grant full access until rotated. |
| **Availability** | RPC dependency, database dependency, signer exhaustion | Timeouts on RPC/DB calls. (Signer burst handling is a known gap). | Ours | Upstream RPC outages will take down the facilitator. |
| **Privacy** | Who paid whom for what, and who can see it | Strict data minimisation and retention policy. See [PRIVACY.md](./PRIVACY.md). | Ours | Operator with database access can see history up to the retention limits. |

## Catalog Poisoning

The facilitator acts as a trust boundary for the Discovery Catalog (Bazaar). Because clients echo the resource block into the payment payload, every field in a listing is attacker-controlled.

Expected attacks include:
- **Path Traversal:** Escaping validation via percent-encoded `..` or scheme separators in `routeTemplate`.
- **Catalog Poisoning:** Forged `serviceName`, oversized `description`, or tag flooding designed to outrank legitimate listings or bloat the index.
- **SSRF / Tracking Probes:** Supplying an `iconUrl` pointing to private IP ranges or tracking pixels.

To mitigate these, the facilitator enforces strict validation and dropping policies. See the **[Validation & Cataloging Policy in BAZAAR.md](./BAZAAR.md#validation--cataloging-policy)** for detailed outcomes on hard/soft drops and resource caps per seller.
