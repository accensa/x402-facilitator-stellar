# Upstream x402 e2e adapter

This directory is the adapter that lets the upstream
[`x402-foundation/x402`](https://github.com/x402-foundation/x402) e2e matrix run
this facilitator as an external component. The source of truth lives here;
upstream gitignores `e2e/facilitators/external-proxies/`, so the two files below
are copied into that directory at run time.

| File | Role |
| --- | --- |
| [`accensa-proxy/run.sh`](accensa-proxy/run.sh) | Starts this service on the harness-assigned port and emits its readiness line. |
| [`accensa-proxy/test.config.json`](accensa-proxy/test.config.json) | Declares the component: name, type, language, protocol family, schemes and health endpoint. |

The full conformance record, including funded-account and USDC prerequisites,
is in [`docs/CONFORMANCE.md`](../docs/CONFORMANCE.md). This page covers only the
adapter contract: what the harness reads, what the shim guarantees, and how to
reproduce a run locally.

## Harness contract

The harness spawns each component and waits for the literal, case-sensitive
string `Facilitator listening` on stdout before it starts scenarios (upstream
`e2e/src/proxy-base.ts`). This service's own boot banner is
`x402 Stellar facilitator listening on :PORT` — lowercase `f` — so that match
would never succeed. [`accensa-proxy/run.sh:45`](accensa-proxy/run.sh) therefore
prints `Facilitator listening on :${PORT}` once `/healthz` answers.

That line is the entire shim. It does not proxy, buffer or rewrite HTTP traffic:
`run.sh` starts `node src/server.js &` and the harness talks straight to our
real HTTP surface on `$PORT`. Keep that property when changing boot logging — a
shim that reshaped requests would invalidate the conformance result.

The second mismatch is the health route. The harness defaults to `/health`;
`test.config.json` declares
`"endpoints": [{ "path": "/healthz", "health": true }]` instead, because the
service already serves `/healthz` and a test harness is not a reason to rename a
public route.

`test.config.json` also declares `"language": "javascript"`. The harness uses
that field to choose the runner environment. This checkout is plain Node.js ES
modules (`"type": "module"` in `package.json`) and the launcher invokes
`node src/server.js` directly, so declaring TypeScript would make the harness
look for compilers or a `tsconfig` that do not exist.
[`test/e2e-descriptor.test.js`](../test/e2e-descriptor.test.js) pins the
descriptor/launcher parity.

## Required environment

[`accensa-proxy/run.sh:24`](accensa-proxy/run.sh) refuses to start unless all
three variables are set:

| Variable | Set by | Meaning |
| --- | --- | --- |
| `ACCENSA_FACILITATOR_DIR` | Operator (CI writes it into `conformance-run.yml`) | Absolute path to this checkout. `run.sh` `cd`s there before starting the service. The descriptor lists it as optional, but the launcher requires it. |
| `PORT` | Harness | Port the component must listen on. The launcher health-checks `127.0.0.1:$PORT` and echoes the banner with that port. |
| `FACILITATOR_SECRET` | Operator, via the harness `.env` | Funded testnet `S…` signing key for the facilitator. Inject it from a secret manager or a gitignored `.env`; never commit it or paste the literal into a shell command. |

`STELLAR_RPC_URL` is an optional override; the service defaults to public
testnet. The harness separately supplies `FACILITATOR_STELLAR_PRIVATE_KEY`,
`CLIENT_STELLAR_PRIVATE_KEY` and `SERVER_STELLAR_ADDRESS` for the Stellar
family. The funder emits `FACILITATOR_SECRET` as the same key the harness is
told about, so the shim and the service behind it are one signer.

## What `run.sh` does at startup

1. Validates `ACCENSA_FACILITATOR_DIR`, `PORT` and `FACILITATOR_SECRET`, then
   `cd`s to the checkout.
2. Starts `node src/server.js &` and traps `EXIT`, `INT` and `TERM` to kill the
   child.
3. Polls `curl -4 -fsS --max-time 2 http://127.0.0.1:$PORT/healthz` up to 60
   times, 0.5s apart. A child that exits during startup is reported immediately
   instead of becoming a 30s timeout.
4. On success emits `Facilitator listening on :$PORT`, waits on the child and
   exits with its status. Without a healthy answer it exits 1.

If boot logging or liveness routing changes, update the shim, the descriptor
and their tests together. Never change the literal string the harness matches
without also changing the harness.

## Reproduce locally

Prerequisites: Node 22 (upstream pins `pnpm@11.1.1`, which needs
`node:sqlite`), pnpm, and funded testnet accounts. `pnpm install:all` is
required — `pnpm install` alone leaves the workspace `@x402/*` packages
unbuilt, and every server fails with
`Cannot find module '@x402/express/dist/cjs/index.js'`.

From a checkout of this repository and a fresh upstream clone:

```bash
git clone --depth 1 https://github.com/x402-foundation/x402.git
cd x402/e2e
pnpm install:all

mkdir -p facilitators/external-proxies/accensa
cp /path/to/x402-facilitator-stellar/e2e/accensa-proxy/* \
  facilitators/external-proxies/accensa/

node /path/to/x402-facilitator-stellar/scripts/fund-testnet-accounts.mjs > .env
echo "ACCENSA_FACILITATOR_DIR=/path/to/x402-facilitator-stellar" >> .env

pnpm test --testnet --families=stellar --facilitators=accensa --min -v
```

`--facilitators=accensa` matters: without it the harness also starts its own
reference facilitators, and a failure in one of those aborts the run before
ours is exercised. The `$0.001` route is priced in USDC, so friendbot funding
alone is not enough; prepare the payer and payee as described in
[`docs/CONFORMANCE.md`](../docs/CONFORMANCE.md) (`npm run testnet:usdc` with a
`TESTNET_USDC_TREASURY_SECRET`) before expecting payments to settle.

To exercise only the shim, with `FACILITATOR_SECRET` already exported from your
secret manager or gitignored `.env`:

```bash
ACCENSA_FACILITATOR_DIR=/path/to/x402-facilitator-stellar \
  PORT=3402 \
  ./e2e/accensa-proxy/run.sh
```

It should print `Facilitator listening on :3402` and then block until the
service exits. From another terminal, `curl -fsS localhost:3402/healthz`
confirms the service the harness will talk to.
