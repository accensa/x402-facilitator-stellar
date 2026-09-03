# `__check_auth` smart-account fixture (issue #13)

A minimal Soroban **account contract** used by
[`scripts/e2e-smart-account.mjs`](../../../scripts/e2e-smart-account.mjs)
(`npm run e2e:smart-account`) to prove that an x402 payment whose payer is a
custom smart account — not a classic ed25519 keypair — verifies and settles
end to end against this facilitator.

An account contract is the shape agent wallets take when they carry a
spending policy: the contract's `__check_auth` is invoked by the Soroban host
whenever a transaction needs the contract's authorization, so the contract
decides which payments its owner may make. The conformance run deploys the
contract, makes the deployed instance the payer, and completes payments with
it.

## What the contract does

Two knobs, both set at deploy time via constructor args:

| Constructor arg | Type | Meaning |
|---|---|---|
| `owner` | `BytesN<32>` | The single ed25519 public key allowed to authenticate this account |
| `spend_cap` | `i128` | Per-authorization spend cap **in stroops**; negative = unlimited |

`__check_auth` then:

1. requires exactly one ed25519 signature, from `owner`, over the host-provided
   signature payload — this is the *authentication* half;
2. if a non-negative `spend_cap` is set, sums the amounts of every token
   `transfer` the authorization permits and rejects the authorization when the
   total exceeds the cap — this is the *spending policy* half.

Both halves are exercised by the e2e run: an unlimited instance settles a
payment, a capped instance settles a payment inside its cap, and a capped
instance rejects a payment over its cap (the rejection surfaces as a
non-null `invalidReason` from `/verify`).

The interface implemented is `CustomAccountInterface` from soroban-sdk
(protocol 22+, the only account interface current testnet dispatches). The
structure follows the published reference — the `account` example in
[`stellar/soroban-examples`](https://github.com/stellar/soroban-examples/tree/v23.0.0/account)
(Apache-2.0) — trimmed to a single owner and a per-authorization cap.
Deliberate simplification, matching the reference's documented limitation: a
production wallet wants a *time-windowed* cumulative cap, not a per-call one.

## Build

The repo commits the built wasm at `test/fixtures/smart_account.wasm`, so the
conformance scripts run without a Rust toolchain. To rebuild it from source:

```bash
# One-time toolchain install (if you don't have Rust):
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none

# Build and copy the wasm to test/fixtures/:
sh ./build.sh
```

Notes:

- The `rust-version` pin in `Cargo.toml` matches the soroban-sdk line; the SDK
  is pinned to `27.0.6`, the current stable protocol line testnet runs (protocol
  28). The example upstream has migrated to the upgraded `CustomAccountInterface`;
  this fixture pins the current SDK so the ABI it speaks is exactly what testnet
  dispatches for contract-account authentication today.
- Target is `wasm32v1-none` (not `wasm32-unknown-unknown`): soroban-sdk >= 27
  refuses the older target on Rust 1.82+.
- The build takes a few minutes the first time (soroban-sdk dependency tree).
- Build only — this repo is deliberately **not** a Rust workspace; the issue
  forbids adding one when a published example / fixture contract will do.
- Verify the built artifact with:
  ```bash
  sh ./build.sh && ls -l ../smart_account.wasm
  ```
- The crate's unit tests (`cargo test`) exercise `__check_auth` locally against
  the Soroban test host (signed payload, wrong signer, in-cap, over-cap,
  negative amount) without touching a network.

## Deploy

Deployment happens inside `scripts/e2e-smart-account.mjs` with stock
`@stellar/stellar-sdk` code (no `soroban` CLI needed):

1. upload the wasm (`Operation.uploadContractWasm`) from a friendbot-funded
   deployer key;
2. create a contract instance (`Operation.createCustomContract` with the wasm
   hash, a fresh salt and constructor args `(owner, spend_cap)`); the address
   that matters is the one the create *simulation returns* — contract IDs fold
   in the network id, and a locally derived sha256 of the preimage silently
   yields an address for a contract that does not exist (the failure mode the
   harness hit and documented);
3. the deployed address becomes the payer's `address` in the SEP-43 signer
   handed to the conformance scheme (`ExactStellarClient` subclass) — the only
   client code that differs from upstream (see `docs/CONFORMANCE.md`, "Glue
   finding").

The `stellar/soroban-examples` CLI equivalent of the two on-chain steps is:

```bash
soroban contract deploy --wasm ../smart_account.wasm --source DEPLOYER --network testnet
soroban contract invoke --id <CONTRACT_ID> --source DEPLOYER --network testnet \
  -- __constructor --owner <OWNER_PUBKEY_HEX> --spend_cap 100000
```