# Bazaar Data Model

## Identity Decision
Identity is the crucial decision for the catalog:
- **HTTP resources** are keyed uniquely by their `url`.
- **MCP resources** are keyed by the tuple `(url, toolName)` because a single MCP server URL can expose multiple tools, and each tool is considered a distinct catalog entry.

## Upstream Type
Derived from `@x402/extensions` (v2.21.0) `DiscoveryResource`.

## API: `GET /discovery/resources`

Allows agents and clients to list discovered resources with optional filtering and pagination.
Pagination uses `limit` (max 100, default 20) and `offset`. The results are ordered by discovery time (newest first).

### Example
```bash
curl "https://facilitator.example.com/discovery/resources?type=mcp&limit=10"
```
```json
{
  "x402Version": 2,
  "items": [
    {
      "type": "mcp",
      "url": "http://mcp.ex",
      "toolName": "search_docs",
      "serviceName": "Documentation Search",
      "scheme": "exact",
      "network": "stellar:testnet"
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 1
  }
}
```

## API: `GET /discovery/search`

Provides search over discovered resources, designed to be called by agents discovering tools on the fly. It takes a natural-language `query` (§3.2), with `limit`/`cursor` pagination and a `partialResults` flag.

### Spec Conformance: `cursor` and `partialResults`

Both are named §3.2 requirements, so their behaviour is pinned by tests (`test/catalog.search.test.js` at the store level, `test/search.http.test.js` at the wire level):

- **`cursor`** is an opaque, base64-encoded string encoding a rank offset (`offset:N`). Like `limit`, it is *advisory* — the server may return fewer results than the page size, and `pagination.cursor` is `null` when there is no next page. An invalid cursor is ignored (treated as page one). Iterating pages with the returned cursor yields each catalog entry exactly once, in stable rank order.
- **`partialResults`** is `true` whenever the result set may be incomplete: when no embeddings provider is configured (the lexical leg is complete, the semantic leg is absent), when the embeddings provider is configured but does not answer, or when any resource in the catalog has no embedding yet (it failed or was never re-embedded). It is `false` only when every retrieval leg that was configured actually ran over every candidate. It is a signal to the agent that the top-N may not be the true top-N, not an error.

### The Ranking Model

Ranking is a weighted lexical score, optionally fused with a dense-embedding leg and reranked when a provider is configured. The lexical weights are in `src/catalog/search.js`; this section is the written model a reviewer can hold against them.

For each whitespace-separated, lowercased token of the query, against each candidate resource:

| Signal | Where | Weight | Reasoning |
|---|---|---|---|
| `serviceName` contains the token | `serviceName` | **+10** | The name is the seller's own short description of the tool. A token in it is the strongest evidence of intent match, so it dominates — deliberately more than any other single signal. |
| `tags` contains the token exactly | `tags[]` | **+8** | An exact tag is a controlled vocabulary match — the seller explicitly classified the resource that way. |
| `tags` partially contains the token | `tags[]` | **+4** | Partial tag match (e.g. `weather` in `weather-api`) is weaker evidence but still useful; half the exact-tag weight. |
| `description` contains the token | `description` | **+3** | Free text is where most content lives, but it is also where keyword-stuffing lands, so it is weighted well below name and tags. |
| `extensions` JSON contains the token | `extensions` (serialized) | **+1** | Parameter descriptions inside the discovery extension are critical for an agent calling the tool, but they are the most remote from intent — a token there alone is weak evidence. |
| Provenance boost | `source === 'payment'` | **+5** | Resources that arrived off a real payment outrank manually-registered ones. See the integrity caveat below — this boost is only as trustworthy as the claim that a payment proves ownership. |

Notes on the model:

- **Scores are additive across tokens.** A multi-token query that hits several signals on one resource accumulates them, which is what lets a phrase like "latitude longitude climate" surface the weather API through its parameter descriptions even though those tokens are nowhere in the name.
- **The boost applies only to lexical matches.** `if (score === 0) return 0` runs before the `+5`, so a payment-verified resource that matches nothing lexically cannot win a query on provenance alone — provenance re-ranks among candidates, it does not conjure them.
- **Decay applies to the whole score, boost included.** The `+5` is added before decay, so an old verified listing decays like any other old listing; verification slows decay's *relative* effect but does not exempt the resource from it.

#### Time decay

Scores decay exponentially with age:

```
score' = score × e^(−daysOld / 43)
```

`43` is the decay constant; the **half-life is ≈ 30 days** (e^(−30/43) ≈ 0.50). The reasoning: a paid resource that stops being reachable is discovered by agents re-verifying it, and a month is a reasonable upper bound on "the endpoint that worked last week still works" for the long tail of a catalog. Something 30 days stale keeps half its rank, something 90 days stale keeps ~12% — it falls, but does not vanish, so agents can still find dormant-but-real tools while fresh ones float to the top. Decay applies only when `daysOld > 0`; a resource with no `last_seen_at` is treated as fresh.

Why exponential rather than a step function: a step (e.g. "drop everything older than N days") creates cliff-edge churn — a resource that is 30 days + 1 second old vanishes from page one entirely. Exponential decay is smooth, so ranking degrades continuously and a single re-verification (`upsertResource`) restores freshness.

#### Hybrid leg (configured only)

When `EMBEDDINGS_URL` is set, a dense leg runs alongside the lexical one: the query and each resource are embedded, cosine similarity is computed, and the two ranked lists are fused with **Reciprocal Rank Fusion** (`k = 60`). When `ENABLE_RERANKING=true`, the fused top page is passed through a reranker. With no provider configured (the memory-backed default), the lexical leg alone decides order and `partialResults` is reported `true` — see above.

#### Integrity caveat: the `+5` verified boost

The boost is only meaningful if "verified" means something. Two properties of the current design weaken it, tracked separately:

- **Cataloguing happens on `/verify` as well as `/settle`** — a listing costs nothing to obtain, so `source: 'payment'` can be true without any settlement having occurred ([#140](https://github.com/accensa/x402-facilitator-stellar/issues/140)).
- **Nothing binds a listing to the URL it claims to own** — first writer wins, and later writes upsert over it, so a third party can list a URL they do not control and describe it however ranks best ([#151](https://github.com/accensa/x402-facilitator-stellar/issues/151); the narrower URL-scheme gap is [#236](https://github.com/accensa/x402-facilitator-stellar/issues/236)).

Until those are resolved, the `+5` is an honest-but-weak signal: it says "a payment payload named this resource", not "the party that controls this URL confirmed it". The ranking model keeps the boost because a settled-listing *does* outrank a never-touched one in the common case, but a reviewer should read it as provenance, not proof. The spoofing fix in #151 should decide whether the boost survives as-is.

### Cold Start
Because ranking over an empty catalog is meaningless, the memory store relies on the testnet and pubnet instances being seeded with a curated set of example tools on startup (or via `POST /discovery/resources` in CI pipelines) to provide immediate utility for first-time callers.

### Pagination & Degraded States
Cursor pagination is implemented via the opaque `cursor` parameter (base64 `offset:N`). Both `limit` and `cursor` are *advisory* — the server may return fewer results. `partialResults` is set to `true` whenever any configured retrieval leg did not run over every candidate — no embeddings provider configured, provider unreachable, or a resource not yet embedded — and is `false` only when every configured leg completed. See "Spec Conformance" above for the pinned behaviour.

### Performance Target
The p95 latency target for this endpoint is **<50ms**, ensuring it does not block agent interactive paths.

## Validation & Cataloging Policy

Automatic cataloging is triggered asynchronously off the payment path for `/verify` and `/settle` when the `PaymentPayload` carries the discovery extension. Manual registration is supported via `POST /discovery/resources` but marked as `source: 'manual'`.

The validation rules for resources submitted to the catalog are as follows:

| Field | Failure | Outcome | Reason |
|---|---|---|---|
| Extension schema | Invalid | **Hard drop** (resource discarded) | Must conform to upstream bazaar spec. |
| `routeTemplate` | Traversal / protocol smuggling / unparseable | **Hard drop** (resource discarded) | Security boundary to prevent SSRF and traversal. |
| `routeTemplate` | Malformed but not hostile (e.g. a bare wildcard `*`) | **Soft drop** (field removed, resource still lands) | Upstream's own SDK registers a wildcard route by default and warns it degrades to auto-generated parameter names — a seller on stock defaults should not silently vanish from discovery. See #65. |
| `serviceName` | Invalid / Oversized | **Soft drop** (field removed) | Protects against UI bloat and poisoning. |
| `iconUrl` | Invalid or private IP | **Soft drop** (field removed) | Protects against SSRF tracking pixels and local probes. |
| `description` | Contains HTML or oversized | **Truncated** (up to 200 chars) | Prevents script injection and limits storage impact. |
| `tags` | Too many tags or oversized | **Filtered** (invalid tags dropped) | Prevents tag flooding and index bloat. |

**Catalog limits:**
- **Rate Limit:** Catalog operations are limited per payer IP to 10 requests per minute (`catalog_rpm` in config).
- **Resource Cap:** A single `payTo` address can have a maximum of 50 resources in the catalog. New inserts beyond this limit are rejected.
- **PayTo changes:** If a resource is already cataloged and a subsequent payment reports a different `payTo`, a warning is logged.

## The `EXTENSION-RESPONSES` Header

Every successful `/verify` (valid payment) and `/settle` (settled payment)
response tells the seller what the Bazaar did with the resource declared in
the payment:

```
EXTENSION-RESPONSES: <base64>
```

The value is the base64 encoding of a JSON object with a single `bazaar`
key — the **envelope**:

```json
{
  "bazaar": {
    "status": "<status>",
    "code": "<code>",
    "reason": "<explanation>"
  }
}
```

`code` and `reason` are present only for the statuses that carry them. Decode
it from a shell with a one-liner:

```bash
curl -si <paid-request> | grep -i extension-responses | cut -d' ' -f2 | base64 -d | jq
```

or in Node:

```js
const header = response.headers.get('extension-responses');
const outcome = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
```

### Worked example

A listing that landed:

```
EXTENSION-RESPONSES: eyJiYXphYXIiOnsic3RhdHVzIjoibGFuZGVkIiwiY29kZSI6ImNhdGFsb2dfc3VjY2VzcyJ9fQ==
```

decodes to:

```json
{
  "bazaar": {
    "status": "landed",
    "code": "catalog_success"
  }
}
```

And one that was rejected because the route template was hostile:

```
EXTENSION-RESPONSES: eyJiYXphYXIiOnsic3RhdHVzIjoicmVqZWN0ZWQiLCJjb2RlIjoiaW52YWxpZF9yb3V0ZVRlbXBsYXRlIn19
```

decodes to:

```json
{
  "bazaar": {
    "status": "rejected",
    "code": "invalid_routeTemplate"
  }
}
```

### Outcomes

| `status` | Meaning | `code` | `reason` |
|---|---|---|---|
| `not attempted` | The payment carried no usable Bazaar discovery extension, so nothing was cataloged. Not an error — the seller simply did not declare discovery metadata. | — | — |
| `landed` | The resource was cataloged and is discoverable. | `catalog_success` | — |
| `partially landed` | The resource was cataloged, but one or more fields were dropped for quality. | `catalog_partial` | `Dropped fields: <field, ...>` |
| `rejected` | The resource was **not** cataloged. | one of the codes below | Set for rate-limit rejections |

### Every code a seller can receive

| `code` | Status | What it means | What to do |
|---|---|---|---|
| `catalog_success` | `landed` | The listing is live. | Nothing. |
| `catalog_partial` | `partially landed` | The listing is live but fields were dropped; `reason` names them. | Fix the named fields (table below) and make a fresh payment — cataloging runs off the payment path and will upsert the corrected listing. |
| `catalog_rate_limited` | `rejected` | Cataloging is metered per caller (default 10/min, `catalog_rpm` via `RATE_LIMIT_GLOBAL`). The payment itself still succeeded — only the cataloging was skipped. | Wait a minute, or raise `catalog_rpm` in the operator's config. |
| `invalid_extension_schema` | `rejected` | The `bazaar` extension in the payment payload does not conform to the upstream spec. | Validate offline with `npx validate-discovery metadata.json` and fix the extension shape, then pay again. |
| `invalid_routeTemplate` | `rejected` | The `routeTemplate` is hostile: path traversal (`..`), protocol smuggling (`://`), or unparseable percent-encoding. This is a security boundary, not a quality nit. | Use a plain path template such as `/api/resource/{id}` and pay again. |
| `missing_or_invalid_discovery_extension` | `not attempted` | No Bazaar discovery extension could be found or extracted from the payment. | If you want to be listed, declare discovery metadata (see the [Seller Guide](SELLER.md)); otherwise nothing to fix. |

### Soft-dropped fields (`catalog_partial`)

When the status is `partially landed`, the `reason` reads
`Dropped fields: <field, ...>`; each named field was removed from an otherwise
live listing:

| Field in `reason` | What was dropped | Fix |
|---|---|---|
| `routeTemplate` | A wildcard or malformed-but-not-hostile template (e.g. the bare `*` the stock SDK registers by default). | Provide a concrete template with named parameters. |
| `serviceName` | Invalid or oversized service name. | A short, plain-text name. |
| `iconUrl` | Invalid or private-IP URL. | A public HTTPS icon URL. |
| `description_truncated` | Description contained HTML or exceeded 200 characters. | Short, plain text. |
| `tags_filtered` | Invalid or oversized tags were dropped. | Fewer, well-formed tags. |

The codes above are extracted from `src/catalog/validation.js` and
`src/app.js`, and `test/extension-responses-doc.test.js` fails if a code is
added to the cataloging path without being documented here.

## Search Quality & Evaluation History

### What `eval/` measures

`npm run eval` (`eval/runner.js`) measures how well the search ranking satisfies real agent intents, end to end through the store's `search()` path. It:

1. Loads a fixed fixture catalog (`eval/fixtures/catalog.json`) into an in-memory store, with artificial `last_seen_at` ages so the decay term is exercised.
2. Runs every query in the human-authored judgement set (`eval/judgements/queries.json`) through `search()` with a mock embeddings provider, so the hybrid leg (embedding + reranking) is exercised deterministically.
3. Scores the returned ranking against graded relevance judgements and reports per-query and aggregate metrics.

The judgement set is deliberately adversarial, not flattering: it includes a keyword-stuffed spam listing (`api.poison.example`) that must *not* rank, a stale legacy listing that must rank but not dominate, a query that only matches via parameter descriptions inside `extensions`, and an empty-result case.

### How judgements are produced

Each judgement is a query, a description of the agent intent behind it, and a relevance grade (0–3) for each fixture URL the query could plausibly return:

- `3` — exactly what the user wants
- `2` — solves the problem, imperfectly
- `1` — marginally relevant
- `0` — irrelevant, or actively harmful (keyword-stuffed)

Judgements are written by humans against the *fixed* fixture catalog, before (and independently of) tuning the weights. The process and contribution guide are in `eval/judgements/README.md`.

### Metrics reported

- **P@3** — precision in the top 3: relevant results / 3.
- **R@3** — recall in the top 3: relevant results found / total relevant in the fixture set.
- **MRR** — mean reciprocal rank: 1 / rank of the first relevant result, averaged over queries.
- **nDCG** — normalized discounted cumulative gain over the top 3, computed against the graded judgements (relevance 0–3), so a result ranked 1 that should be 3 costs more than one that should be 1.

### What counts as a regression

The runner gates merges on two aggregate thresholds, enforced in CI on every relevant change (`eval` job in `.github/workflows/ci.yml`):

- **nDCG ≥ 0.85**
- **MRR ≥ 0.8**

A change that moves either below its threshold fails CI. P@3 and R@3 are reported but not gated; they are noisier at this fixture size and are watched rather than enforced.

### Current scores (committed baseline)

Scores are committed here so movement is visible over time rather than asserted. Reproduce with `npm run eval`.

| Release | Date | P@3 | R@3 | MRR | nDCG | Notes |
|---------|------|-----|-----|-----|------|-------|
| `v0.0.1` | 2026-08-12 | 0.625 | 1.000 | 1.000 | 0.991 | Initial lexical baseline release |
| `v0.0.2` | 2026-08-12 | 0.583 | 1.000 | 1.000 | 1.000 | Hybrid semantic search via API |
| `v0.0.3` | 2026-08-26 | 0.583 | 1.000 | 1.000 | 1.000 | Baseline reproduced under the documented methodology (issue #153) — no algorithm change |

### Maintenance plan

Search quality is a maintained property, not a one-time measurement:

- **Who re-runs it:** CI runs `npm run eval` on every push and pull request. A contributor changing retrieval or ranking runs it locally before opening the PR.
- **How the judgement set grows:** additions to `eval/judgements/queries.json` are accepted even when they make current scores drop — accuracy of measurement outranks a high score. The contribution guide in `eval/judgements/README.md` names the cases most wanted: realistic agent queries, empty-result cases, and adversarial keyword-stuffed listings.
- **When to re-baseline:** any change to the ranking algorithm, the fixture catalog, or the embeddings/reranking wiring requires a fresh `npm run eval` and a new row in the scores table above. If the aggregate metrics move materially, the change ships with the new numbers and the reasoning, not with a hand-waved "should be fine".
- **Known limitation:** the fixture catalog is small and human-curated, and the embeddings provider in the harness is a keyword mock, so absolute numbers are directional, not a guarantee about the live catalog. See `eval/judgements/README.md` for the full limitation list.

## Full Re-index Procedure

Because this is an in-memory conformance spike, re-indexing is implicit on restart. All catalog items are rebuilt as payments arrive.

For a persistent deployment, a full re-index (required when changing the embedding model) is performed by:
1. Configuring the new embedding model endpoint.
2. Iterating through the primary catalog table.
3. Repopulating the dense vectors.
4. Hot-swapping the new vector index.
