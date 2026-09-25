- closes #170
- closes #169
- closes #209
- closes #211

## #170 — the reranker posted to a hypothetical endpoint and failed silently

`EmbeddingClient` derived the rerank URL as `${EMBEDDINGS_URL}/rerank`, a path no
rerank provider serves, and treated every failure as "carry on in fused order".
An instance could therefore believe it was reranking while it was not, and the
eval harness could not tell the difference: its mock reranker answered every
document with `1.0`, which preserves the order it was handed, so a dead second
pass produced identical numbers.

- `RERANK_URL` is now an explicit full URL. Nothing is inferred from
  `EMBEDDINGS_URL`.
- `resolveConfig` refuses `ENABLE_RERANKING=true` without `RERANK_URL`, and
  requires an absolute http(s) URL when it is set. This fails at boot, where it
  costs a restart, instead of silently at query time.
- A store built directly (tests, the eval harness) degrades loudly rather than
  silently.
- The rerank response is parsed into positional scores against the documented
  `{ results: [{ index, relevance_score }] }` contract; a payload that does not
  match is reported as a failure rather than mistaken for a rerank that happened
  to preserve order.
- The eval mock now scores on query-token overlap, so a missing or broken second
  pass moves nDCG. Reranking also has its own `ProviderHealth`, so a flapping
  reranker no longer suppresses embedding calls.

## #169 — the MCP server hardcoded protocolVersion 2024-11-05

`initialize` always answered `2024-11-05` and never read the client's request.

The server now negotiates against `SUPPORTED_PROTOCOL_VERSIONS`
(`2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`), echoes the client's
revision when it is implemented, and otherwise counter-offers the newest
handshake-era revision and logs a warning. Every listed revision is
handshake-era, so the tool surface this server implements is unchanged across
them and the echo is an honest claim. Modern (no-handshake) clients are out of
scope: they never send `initialize`.

## #209 — `handleRateLimit` was called twice per request and its return discarded

Two wrappers (`rejectRateLimited`, `applyRateLimitHead`) spread this over eight
call sites, producing two defects:

1. A request could reach the header logic twice — once from the pre-record check
   and again from the post-record state — so advertised `RateLimit-Remaining`
   was written and overwritten rather than decided once.
2. The post-record call sites discarded the return value. When the limiter's
   post-record state was a refusal, that reply *was* the response; ignoring it
   and continuing to `reply.send(...)` is a double send, which Fastify answers
   with a **500**. The caller got neither the allowed response nor the 429.

The two wrappers collapse into a single `handleRateLimit`, and every caller now
honours the result:

```js
const limited = handleRateLimit(reply, recorded, check);
if (limited) return limited;
```

`recordCatalog` and `recordCatalogRead` now return post-record state, matching
`recordVerify`, so the discovery write path advertises the same headers the HTTP
surface audit promises.

## #211 — the image omitted `scripts/` and `migrations/`

`docs/DEPLOYMENT.md` documents
`node scripts/db-migrate.js up && node src/server.js` as the container
entrypoint, and `scripts/db-migrate.js` resolves `../migrations` relative to its
own location. The Dockerfile copied only `src/`, so a released image built,
booted and served — then failed every migration command in the runbook on a
missing path.

Both directories now ship, `--chown`ed to the non-root user. A new test asserts
on the shipped contents, since nothing previously did.

## Verification

| Gate | Result |
| --- | --- |
| `npx eslint .` | clean |
| `npx prettier --check .` | clean |
| `npm test` | 662 / 663 pass |
| `npm run eval` | passes (nDCG 0.991) |
| `npm run env:check` | OK |
| `npm run check:migration` | 0 errors, 8 pre-existing warnings |

The single test failure, `test/process-handlers.test.js:83` ("server.js reports
a bind failure and exits non-zero"), reproduces unchanged on the parent commit
and is unrelated to these changes. It is left as-is rather than folded in, so
this PR stays limited to the four issues.
