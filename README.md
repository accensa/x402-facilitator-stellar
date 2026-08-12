<div align="center">
  <h1>x402-facilitator-stellar</h1>
  <p><strong>An x402 facilitator for Stellar — verify, settle, supported</strong></p>
  <p>
    <img src="https://img.shields.io/badge/status-conformance%20spike-orange.svg" alt="Status: conformance spike" />
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License Apache 2.0" />
    <img src="https://img.shields.io/badge/stellar-testnet-success.svg" alt="Stellar testnet" />
    <img src="https://img.shields.io/badge/x402-v2-blue.svg" alt="x402 v2" />
  </p>
  <p>
    <a href="#conformance"><strong>Conformance</strong></a> ·
    <a href="#getting-started"><strong>Getting Started</strong></a> ·
    <a href="#known-gaps"><strong>Known Gaps</strong></a> ·
    <a href="https://github.com/x402-foundation/x402"><strong>x402 spec</strong></a>
  </p>
</div>

> Developer infrastructure for x402 on Stellar, built on the Apache-2.0
> [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) package. Independent of
> the merchant back-office in [`accensa-app`](https://github.com/accensa/accensa-app) and
> [`accensa-contracts`](https://github.com/accensa/accensa-contracts) — a seller can use
> those without this, and an agent can use this without those.

> [!WARNING]
> **This is a conformance spike, not a production facilitator.** It exists to answer one
> question: can an unmodified canonical x402 client complete a payment against a
> facilitator we operate on Stellar testnet? It makes no availability claim, has no
> persistence, and does not implement the Bazaar discovery layer.

## The Problem

x402 turns HTTP 402 into a machine-native payment flow: a client requests a resource, the
server replies `402` with terms, the client signs a payment authorization and retries, and
a **facilitator** verifies and settles on-chain before the resource is returned.

The facilitator is the piece a seller cannot easily run themselves. It has to validate
Soroban authorization entries strictly — correctly signed, authorizing exactly the
declared call, asset, amount and recipient, not replayed, not expired — submit the
invocation, and cover the network fee so the buyer needs only the payment asset. Get any
of that subtly wrong and the failure is silent: payments that look settled and are not,
or authorizations that grant more than the payer understood.

## Why Not Reimplement It

`@x402/stellar` already ships `ExactStellarScheme`, which implements the
`SchemeNetworkFacilitator` interface — `verify`, `settle`, `getExtra`, `getSigners` —
and validates:

- auth-entry structure and credential type
- expiration against a maximum ledger
- **facilitator safety** — the facilitator must not be a party to the transfer
- **absence of sub-invocations** — no authorization the payer did not see
- payer signature status, and that no other signatures are pending
- via simulation, that there is **exactly one** transfer event matching the expected
  sender, recipient, amount and asset

None of that is reimplemented here. It is the part most dangerous to get subtly wrong, and
rewriting it would duplicate the package the ecosystem is standardizing on.

**This repo is the transport around it.** `@x402/core` ships no facilitator router — it
gives you `x402Facilitator` with `verify()`, `settle()` and `getSupported()`, and the HTTP
surface is yours to write. That surface, plus configuration, caller authentication and
operational concerns, is what lives here.

## Architecture

```mermaid
flowchart LR
    A[Buyer agent] -->|1. request| RS[Resource server]
    RS -->|2. 402 + terms| A
    A -->|3. PaymentPayload| RS
    RS -->|4. POST /verify, /settle| F

    subgraph F[" this repo "]
        HTTP["/verify · /settle · /supported"]
        SCHEME["ExactStellarScheme<br/>@x402/stellar"]
        HTTP --> SCHEME
    end

    SCHEME -->|5. submit auth entry| SOR[(Stellar / Soroban)]
    SCHEME -.->|fee sponsored by facilitator| SOR
```

| Route | Purpose |
|---|---|
| `GET /supported` | Supported kinds, extensions and signers — including the Stellar `extra` block with `areFeesSponsored` |
| `POST /verify` | `{paymentPayload, paymentRequirements}` → `VerifyResponse` |
| `POST /settle` | `{paymentPayload, paymentRequirements}` → `SettleResponse` |
| `GET /healthz` | Liveness |

## Getting Started

### Prerequisites

- Node.js ≥ 20
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools) for key management

### Three distinct accounts are required

`ExactStellarScheme` rejects any payment where the facilitator is a party to the transfer.
Payer, recipient and facilitator must therefore be three different accounts — reusing the
merchant key as the facilitator key fails verification on the very first request.

```bash
stellar keys generate facilitator --network testnet --fund
```

### Run locally

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
export FACILITATOR_SECRET=$(stellar keys show facilitator)

# 3. Serve
npm start
```

```bash
curl -s localhost:3402/supported | jq
```

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "stellar:testnet",
      "extra": { "areFeesSponsored": true }
    }
  ],
  "extensions": [],
  "signers": { "stellar:*": ["G..."] }
}
```

### Tests

```bash
npm test          # unit tests — no network, no funded account, no .env
npm run test:watch
```

The unit suite covers configuration resolution, the HTTP surface (status codes,
reason codes, pass-through fidelity, caller auth) and the RPC retry wrapper. It
stubs the facilitator throughout: `ExactStellarScheme` is upstream's and is not
retested here.

The end-to-end conformance run is separate, because it needs testnet and two
funded accounts:

```bash
FACILITATOR_SECRET=$(stellar keys show facilitator) npm start &
ALICE_SECRET=$(stellar keys show alice) npm run e2e
```

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `FACILITATOR_SECRET` | *required* | `S…` secret for the testnet signer |
| `PORT` | `3402` | |
| `STELLAR_RPC_URL` | package default | Public testnet RPC is fine; a provider URL is wanted for pubnet |
| `MAX_TX_FEE_STROOPS` | `50000` | Fee ceiling per settlement. Configurable, never hard-wired |
| `FACILITATOR_API_KEYS` | *(unset)* | Comma-separated. Unset means open, which is correct for a free testnet instance and is logged at boot |
| `ENABLE_PUBNET` | `false` | Requires `FACILITATOR_SECRET_PUBNET`; refuses to start without it |

Pubnet is opt-in behind its own secret deliberately: running a mainnet facilitator from a
testnet-shaped config loses real money.

## Conformance

Acceptance is tested at the wire level with stock SDK code, not by reading a claim. What
holds today on testnet:

- [x] `/supported` emits the Stellar `extra` block including `areFeesSponsored`
- [x] Every rejection carries a non-null `invalidReason` — across malformed bodies,
      unregistered scheme/network pairs, and scheme-level failures
- [x] The spec's `payload: {transaction}` shape is accepted verbatim
- [ ] An unmodified canonical client completes a payment end-to-end
- [ ] Settled transaction hash published
- [ ] `stellar:pubnet`
- [ ] The x402 repository's e2e suite

Responses use the canonical field names — `VerifyResponse` carries `invalidReason` and
`invalidMessage`; `SettleResponse` carries `errorReason`, `errorMessage`, `transaction`
and `network`. There is no `reason` field, and inventing one produces a service that looks
correct locally and is non-conformant on the wire.

## Known Gaps

- **One signer.** `ExactStellarScheme` accepts an *array* of signers with a round-robin
  `selectSigner`, plus an optional `feeBumpSigner` that decouples fee payment from
  sequence-number management. That pair is how bursty agent traffic avoids sequence
  contention. One signer is enough to prove conformance and not enough to serve load.
- **No Bazaar.** Discovery, search and automatic cataloging are absent. This spike is only
  about the payment path.
- **No persistence, metering, or rate limiting.**
- **`exact` only.** The `upto` scheme has no Stellar specification yet; design notes in
  [`accensa-contracts/docs/ADR-002`](https://github.com/accensa/accensa-contracts/blob/main/docs/ADR-002-upto-scheme.md).

## Contributing

Issues and pull requests welcome. Given the status above, the most useful contribution is
a conformance failure: point a canonical client at it and report what breaks.

## Contributors

<a href="https://github.com/accensa/x402-facilitator-stellar/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=accensa/x402-facilitator-stellar" />
</a>

## License

Apache-2.0 — see [LICENSE](LICENSE). Chosen to match upstream `@x402/*` so work here can
be contributed back.
