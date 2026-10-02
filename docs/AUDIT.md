# Audit-Readiness Package

## Audit Trail (#109)

Sensitive operations are recorded by `src/audit.js` as one JSON object per
line, each carrying `"channel": "audit"` so records are separable from
diagnostic logs (filterable at shipment; optionally mirrored to `AUDIT_LOG_FILE`
for independent retention). Every record carries a timestamp (`ts`), the
authenticated caller (`actor`: `keyId`, or `ip:<pseudonym>` in open mode),
the action (`event`) and the outcome. The open-mode actor is a keyed,
non-reversible pseudonym of the source address, never the address itself — see
docs/PRIVACY.md §2 and §3a.

### What is audited, and why

| Event | Included because |
|---|---|
| `settlement` | Money moved (or was attempted). Carries the **transaction hash**, network, fee and outcome, so a disputed settlement can be reconstructed against the chain. This is the record the audit trail exists for. |
| `verification` | The gate before settlement. Outcomes and rejection reasons are needed to reconstruct why a payment never proceeded. |
| `catalog_write` | A public listing is created or overwritten. Without it, a spoofed or hijacked listing cannot be investigated after the fact. Records url, tool name, source (payment/manual) and whether an existing entry was overwritten. |
| `auth_failure` | Authentication probing/brute force. Records the reason code and the pseudonymised source identifier — never the presented key material, and never the raw source address. |
| `rate_limit_rejected` | Abuse signal and evidence trail for callers hitting ceilings, including `fee_ceiling_exceeded` and store-unavailable refusals. |
| `rpc_unreachable` | An open circuit breaker caused a caller-visible failure. Distinguishes "our dependency died" from "your payment was rejected" in the trail. |

### What is deliberately not audited

- **Reads** (`/supported`, `/discovery/resources`, `/discovery/search`,
  `/usage`): no state changes, no money. Logging them would grow the trail
  without evidentiary value and conflict with data minimisation
  (docs/PRIVACY.md).
- **Full request payloads**: never recorded — payloads carry signatures and
  XDR blobs with no audit value once outcome + transaction hash are on file.
- **Key material**: `req.keyId` only, never the key itself; the logger
  additionally redacts secret-shaped fields as defence in depth.

### Relationship to structured application logging (#7)

#7 covers diagnostic logging, correlation IDs and metrics. This audit trail is
a distinct artifact with different retention and integrity requirements, but
it is not a second logging mechanism: it is a single structured writer
emitting self-describing JSON lines that can be routed by the same shipment
infrastructure #7 introduces. Retention follows docs/PRIVACY.md §7: audit
records of settlements inherit the 90-day settlement-record class, other audit
records the 7-day request-log class, pending the automated enforcement tracked
in #50.

## Proposed Scope

## Proposed Scope
The scope of the audit includes the HTTP transport, configuration, authentication, and operational concerns implemented in this repository (`x402-facilitator-stellar`).

**Out of Scope (Upstream):** 
The core verification and settlement logic is explicitly **out of scope**. This includes auth-entry structure validation, expiration checks, facilitator safety checks, and simulation of the Stellar transfer. These are handled by the Apache-2.0 `ExactStellarScheme` from `@x402/stellar`, which should be audited separately.

## Trust Boundaries
- **External Network (Untrusted):** Buyer agents, resource servers, and Bazaar search clients.
- **API Boundary (Verified):** Requests matching valid API keys (if configured) or passing rate limits.
- **Upstream RPC (Trusted but Unreliable):** The Stellar RPC endpoint.
- **Database (Trusted):** The persistent store for logs, settlement records, and the Bazaar catalog.

## Security-Relevant Invariants
An auditor should attempt to break the following invariants:
1. The facilitator never settles an authorization where it is a party to the transfer.
2. A single request cannot consume more than `MAX_TX_FEE_STROOPS` in sponsored fees.
3. Replayed or duplicated `verify` / `settle` payloads are rejected.
4. API keys cannot be bypassed or brute-forced via timing attacks.
5. Catalog entries cannot contain cross-site scripting (XSS) payloads or path traversals.

## Known Issues and Accepted Risks
- **Single Signer Contention:** Currently, only a single signer is used. Under high load, sequence number contention may occur. This is an accepted risk for this conformance spike.
- **RPC Outage Dependency:** The service will fail if the upstream Stellar RPC goes down.
- **Database Access:** Operators with physical access to the DB can view settlement history up to the retention limit.

## Dependencies and Licensing
- Built on `@x402/stellar` (Apache-2.0).
- All dependencies are MIT or Apache-2.0. CI explicitly checks for the absence of AGPL or other viral licenses.
