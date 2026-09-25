# Privacy, User Tracking, and Data Minimisation Policy

This document outlines our approach to user tracking, data minimisation, and data retention within the X402 Facilitator service. Our goal is to collect only what is strictly necessary to operate the service and nothing more.

## 1. What is Collected

Data collection is strictly scoped by subsystem:

- **Request Logs**: We collect timestamps, endpoint paths, response status codes, latency and outcome. The address of the caller is **not** logged; IP addresses are used only for rate limiting and are pseudonymised before use (see §2). The structured request line carries no field that could hold an address, a payload or a credential (see `src/log.js`).
- **Settlement Records**: For successful settlements, we store transaction identifiers (hashes), amounts, seller endpoints, and the payer's Stellar account ID necessary for refund routing. *(Note: Durable storage of settlement records is not yet implemented. See issue #10)*
- **Catalog Entries (The Bazaar)**: Seller endpoints, offered resources, prices, and descriptive metadata as submitted by the seller.
- **Search Queries**: Search terms used in the Bazaar are recorded for query evaluation and quality improvement (hybrid search ranking). *(Note: Search query collection is not yet implemented. See issue #25)*
- **Usage Counters**: Aggregated metrics on request volumes, settlement success rates, and active seller counts.

## 2. What is Deliberately Not Collected

We do not collect or retain the following (this is verifiable in our codebase):

- **IP Addresses**: Raw addresses are never written to logs and never persisted. To rate-limit per caller, the address is reduced to a **keyed, non-reversible pseudonym** (HMAC-SHA-256) before it becomes a rate-limit bucket key or an audit actor. The key comes from `IP_HASH_SECRET`, or — when that is unset — is derived from the facilitator signer secret, so pseudonymisation is on by default. A shared store (Redis, `RATE_LIMIT_STORE=postgres`, the multi-region CRDT store) therefore holds only the pseudonym, and it expires with its rate-limit window.

  The pseudonym is stable for the lifetime of a key: the same address maps to the same bucket so limits still apply, and a different address maps to a different bucket. Rotating `IP_HASH_SECRET` re-keys every bucket, which is a deliberate lever an operator can pull to break linkability across deployments; the cost is that in-flight rate-limit windows reset.
- **Agent Fingerprinting**: No cross-request tracking of user-agents or browser fingerprints.
- **Query-to-Payer Linking**: Search queries are *never* linked to a payer's identity, IP, or settlement records.
- **Auth-Entry Material**: No secrets, auth tokens, or exact cryptographic signatures are recorded in our application logs.

## 3. Search-Query Handling

Search queries submitted to the Bazaar are highly sensitive as they reveal user intent. 
- Queries are temporarily retained for evaluating search performance (e.g., hybrid retrieval accuracy).
- They are **never linked to a payer's identity**.
- Queries are aggregated and anonymized before being used for any search tuning.
- All raw query data is subject to our strict 30-day retention policy.

*(Note: Search query retention and anonymization controls are pending the implementation of query collection. See issues #50 and #25)*

## 3a. IP Pseudonymisation in Practice

Every HTTP request resolves the client address (honouring `TRUST_PROXY`; never trusting client-supplied `X-Forwarded-For` beyond the configured hop count) and immediately replaces `req.ip` with its pseudonym (`src/ip.js`, applied in `src/app.js`). Because every consumer — the rate limiter, the audit writer, the catalog warning — reads `req.ip`, that single replacement is what guarantees no downstream path can retain the raw address.

The pseudonym is 24 hex characters (a truncated HMAC-SHA-256 digest). Truncation is safe here: a collision only merges two callers into one bucket, which is a rate-limiting nuisance, not a privacy or security failure. `IP_HASH_SECRET` is the operator's own key; when it is unset the key is derived, domain-separated, from the facilitator signer secret. An instance whose signer is known to an attacker is compromised regardless of this key.

## 4. The Public Catalog Tension

The Bazaar acts as a **public catalog**. When a seller registers their endpoint and pricing, this metadata is intentionally published and indexed to allow buyers to discover resources. 

We acknowledge the tension between building a useful, discoverable catalog and a seller's potential expectation of privacy regarding their pricing. 
- **By registering with the Bazaar, sellers explicitly opt-in to having their endpoint and pricing metadata published.** 
- If a seller requires private pricing or unlisted endpoints, they should operate outside the public Bazaar index.
- We may publish aggregate statistics (e.g., average prices for resource categories), but these are always aggregated so a single seller's activity cannot be reconstructed.

## 5. Access Control

Operator access to settlement and query data is strictly limited:
- Only authorized operators have read access to the production database for debugging and support purposes.
- All access to this data is logged and periodically audited.

*(Note: The production database and access audit logging are not yet implemented. See issues #10 and #50)*

## 6. Self-Hosting as the Privacy Answer

If an operator or a consortium does not wish to share this data with our hosted instance, **self-hosting is a fully supported alternative**. 
You can run your own instance of the X402 Facilitator. By doing so, you retain complete physical and logical control over all request logs, settlement records, and search queries within your environment.

## 7. Retention Periods and Enforcement

We adhere to the following retention periods:
- **Request Logs**: 7 days.
- **Audit Records** (`channel: "audit"`, see docs/AUDIT.md): settlements follow the settlement-record class below; all other audit records follow the request-log class. They are separable from diagnostic logs precisely so these classes can be enforced independently.
- **Search Queries**: 30 days.
- **Settlement Records**: 90 days (retained longer for dispute resolution and refund processing).

### Enforcement

These retention periods represent the policy the service commits to. The automated deletion job (`scripts/data_retention_job.js`) to enforce these periods is not yet implemented. This work is currently tracked in issue #50.
