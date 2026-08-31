# Contributing

Thanks for considering a contribution. This is a conformance-focused x402
facilitator for Stellar — a thin transport over the canonical
[`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) package. The
whole repo leans on a handful of conventions being followed, and most of them
are only discoverable by having CI reject a PR. This file is where they live.

Start with [`README.md`](README.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
and [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md), and open the matching issue
before you start so you get assigned. If you are contributing through the Drips
Stellar Wave, include `Closes #<issue>` in the PR description.

## Node versions, and why they differ between jobs

- **Develop against Node 22.** The repo pins it in [`.nvmrc`](.nvmrc), and it is
  the version CI lints and formats with. ESLint 9 requires Node >= 22, which is
  why the `lint` and `format` jobs run on 22 only.
- **`package.json` declares `engines: >= 20`.** That claim is real and tested:
  the CI `test` job runs the suite on both Node 20 and Node 22. So your code
  must run on 20 too — but write and test against 22, then let CI prove 20.

If you use `nvm`/`fnm`, `nvm use` honours `.nvmrc` and puts you on 22.

## The full local check sequence

From a clean clone, everything CI runs, in one pass:

```bash
npm install
npm run lint          # ESLint — unused bindings, accidental globals, empty catches
npm run format:check  # Prettier --check; never --write. Fix with npm run format.
npm test              # node --test — fast, offline, no funded accounts
npm run licenses      # permissive-only dependency policy (see below)
npm run check:migration # required if you touched migrations/ (far more likely than you think)
```

Run the whole block before opening a PR. `npm test` needs no network, no `.env`
and no funded account — if it fails locally it will fail in CI, so fix it
before you push rather than burning a CI slot.

The scripts are the source of truth; this file deliberately lists names rather
than restating their contents, so a changed script does not silently invalidate
the docs.

### When the extra gates apply — not every PR

- **`npm run eval`** — required only when you touch the discovery/search or
  catalog code. It scores the retrieve/rerank path against the judgement set in
  `eval/judgements/`, and is a hard CI gate on those changes. If you only touch
  docs or the HTTP surface, you can skip it locally; CI still runs it, and it
  is cheap.
- **`npm run e2e`** — the upstream conformance run needs Stellar testnet, a
  funded treasury and friendbot, so CI keeps it in a separate workflow (below).
  Run it locally only if you changed the HTTP/settlement surface and you can
  reach testnet.
- **`npm run check:migration`** — zero-downtime migration guardrail. Required
  for any `migrations/` change (blocks `DROP`/`RENAME`/`LOCK TABLE` in expand
  phases). See [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md).

### Dependency licence policy

The project commits to a **permissive-only dependency tree**: no AGPL (and no
SSPL, BUSL or CC-BY-NC) anywhere in the dependency graph, because a copyleft
transitive would make the service undistributable on the terms it promises.
`npm run licenses` enforces this by scanning every package's `license` field
and fails the build otherwise. **A dependency addition has no heads-up other
than this check** — run `npm run licenses` (or `node scripts/check-licenses.mjs --list`
to see the inventory) before merging anything that changes `dependencies`.

## Running conformance against a branch

The upstream e2e suite lives in its own workflow
(`.github/workflows/conformance.yml`) because it depends on testnet, friendbot
and a third-party repository — none of which should turn a docs PR red. You can
exercise it without waiting for a nightly run or merging an untested workflow
to `main` by **pushing a branch named `conformance/**`** (e.g. `conformance/my-change`);
the workflow runs on that push. You can also trigger it manually from the
Actions tab (`workflow_dispatch`, optionally picking an `x402_ref`).

## Commit and PR conventions

- Link the issue: `Closes #N` in the PR description.
- Fill in the PR template's **"How it was verified"** with the actual commands
  you ran, and answer **"Wire format"** honestly — a field renamed by accident
  is a conformance failure that passes every local test, so it needs saying
  out loud if your change alters anything a client can observe.
- One rule specific to this repo: we do **not** reimplement `verify`/`settle` —
  that logic lives upstream in `@x402/stellar` (see
  [`SUPPORT.md`](SUPPORT.md)). A PR that reimplements it is rejected regardless
  of quality; ask first if an issue looks like it requires that.

## Git blame across formatting commits

Two history-wide Prettier passes pollute `git blame`. They are recorded in
[`.git-blame-ignore-revs`](.git-blame-ignore-revs); enable them once so blame
skips those commits and you see the real author of each line:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```
