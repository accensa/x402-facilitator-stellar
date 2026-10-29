# Stellar `pact` Scheme Specification

**Status:** Implemented (testnet), `src/pact-scheme.js`
**Contract:** [Pactwright `pact`](https://github.com/Pactwright/Pactwright-contracts) (escrow; testnet `CDUXJJUNYFILEYHE3LITANJEKCDFERNAABOSG75OWATFVM776BCMFEV6`)

The `pact` scheme lets a buyer pay into an escrow contract instead of paying the seller
directly. The payment is a buyer-signed `pact.open(params)` that moves the price (`cap`) from
the buyer to the contract. A verifier's signed verdict, the buyer's signed usage, or a deadline
decides later how much the seller gets; the rest goes back to the buyer. The facilitator pays
the fee and is never a party to the money.

## Decision

| | |
|---|---|
| Context | `exact` pays the seller at once, so a wrong or missing delivery needs the seller's goodwill to refund. Agents need a payment that waits for proof of delivery. |
| Decision | Add a second scheme, `pact`, next to `exact`, with the same transport (x402 v2 over `/verify` and `/settle`) and the same safety model (one invocation, simulated, auth entries checked, facilitator never a party). Follow-up calls on the pact go through `POST /pact/submit`, which sponsors only an allow-list of functions on the configured contract. |
| Alternatives | A separate escrow facilitator (duplicates signers, keys, rate limits and fee budgets); letting `/settle` submit any contract call (the facilitator would sponsor arbitrary code). |
| Consequences | Operators opt in per network with `PACT_CONTRACT_ID` / `PACT_CONTRACT_ID_PUBNET`. `open` pays storage rent, so the scheme has its own fee ceiling (`PACT_MAX_TX_FEE_STROOPS`, default 250000). `exact` is unchanged. |

## 1. Network identifier

`stellar:testnet` or `stellar:pubnet`. The scheme is offered only on networks with a configured
pact contract; `/supported` lists it with `extra.pactContract`.

## 2. Payment requirements

```json
{
  "scheme": "pact",
  "network": "stellar:testnet",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "amount": "10000000",
  "payTo": "G…seller",
  "maxTimeoutSeconds": 60,
  "extra": {
    "areFeesSponsored": true,
    "pactContract": "C…pact",
    "pactwright": {
      "condition": { "kind": "document.translation", "lang": "pt", "minPages": 4 },
      "silence": "refund"
    }
  }
}
```

`amount` is the cap in the asset's smallest unit. `extra.pactwright.condition` is the condition
the buyer freezes (or `conditionHash`, its hash); `silence` is what happens if no verdict arrives.

## 3. Payment payload

```json
{
  "x402Version": 2,
  "accepted": { "...": "the requirements above" },
  "payload": { "transaction": "AAAA… (base64 XDR)" }
}
```

The transaction holds one `invokeHostFunction` calling `pact.open(OpenParams)`. The buyer's
authorization is a signed Soroban auth entry (address credentials), as in `exact`: root
invocation `pact.open`, one sub-invocation `token.transfer(buyer, pact, cap)`. The
transaction's source is not the buyer's to spend from; the facilitator rebuilds it with its own
source account.

## 4. Verification (`/verify`)

A payment is valid only if every rule holds. Each failure has its own `invalidReason`
(prefix `invalid_pact_stellar_payload_`):

| Rule | Reason |
|---|---|
| x402 v2, scheme `pact`, matching Stellar network | `invalid_x402_version`, `unsupported_scheme`, `network_mismatch`, `invalid_network` |
| The network has a configured pact contract, and the requirements name the same one | `…network_not_configured`, `…wrong_contract` |
| One `invokeHostFunction`, neither tx nor op source is the facilitator | `…malformed`, `…wrong_operation`, `…unsafe_tx_or_op_source` |
| The call is `open` on the configured contract | `…wrong_contract`, `…wrong_function_name` |
| The facilitator is neither buyer nor seller | `…facilitator_is_party` |
| `seller == payTo`, `cap == amount` | `…wrong_recipient`, `…wrong_amount` |
| `condition_hash == sha256(JCS(condition))` (and/or `conditionHash`) | `…condition_hash_mismatch` |
| `silence` is the policy the seller offered | `…wrong_silence` |
| Simulation succeeds; a reused auth entry or `pact_id` is reported as such | `…replayed`, `…pact_id_used`, `…simulation_failed` |
| Fee within `PACT_MAX_TX_FEE_STROOPS` | `…fee_exceeds_maximum` |
| Exactly one token transfer: `buyer → pact`, `cap`, in `asset`; no other events but the pact's own | `…no_transfers`, `…multiple_transfers`, `…wrong_transfer`, `…unexpected_event` |
| Auth entries: address credentials, no facilitator, expiry within `maxTimeoutSeconds` | `…no_auth_entries`, `…unsupported_credential_type`, `…facilitator_in_auth`, `…signature_expiration_too_far` |
| Auth tree: `pact.open` → only `token.transfer(buyer, pact, cap)` | `…unexpected_auth`, `…unexpected_subinvocations` |
| The buyer signed; nothing else is pending | `…missing_payer_signature`, `…unexpected_pending_signatures` |
| The seller holds a trustline for the asset | `…seller_trustline_missing` |

## 5. Settlement (`/settle`)

Re-verifies, rebuilds the invocation with a facilitator source account and the simulated
footprint, signs (optionally fee-bumped), submits and waits. On success the response carries
`extensions.pactwright.pactId`. `/settle`'s idempotency, rate limits and daily fee budget apply
unchanged.

## 6. Follow-up calls (`POST /pact/submit`)

```json
{ "network": "stellar:testnet", "transaction": "AAAA… (base64 XDR)" }
```

Sponsors one call on the configured pact contract, from this allow-list only:
`record_verdict`, `settle`, `close_meter`, `release`, `extend_pact_ttl` (`open` goes through
`/settle`). The caller signs whatever auth the call needs (the seller for `settle` and
`close_meter`; `record_verdict` carries the verifier's signature as an argument; `release` and
`extend_pact_ttl` need none). Same API keys, rate limits and daily fee budget as `/settle`.
Failures (prefix `invalid_pact_submit_`): `…network_not_configured`, `…malformed`,
`…wrong_operation`, `…unsafe_tx_or_op_source`, `…wrong_contract`, `…function_not_allowed`,
`…simulation_failed`, `…fee_exceeds_maximum`, `…facilitator_in_auth`,
`…signature_expiration_too_far`, `…unexpected_pending_signatures`.

## 7. Evidence

`test/integration/pact-scheme.testnet.test.js` runs the scheme against the deployed contract
on testnet: a buyer-signed `open` verified and settled by the facilitator, the replay rejected,
then `record_verdict` and the seller's `settle` through `/pact/submit`, ending with the pact
`Settled` at 0.75 to the seller and 0.25 back to the buyer. `test/pact-scheme.test.js` holds
one negative test per rule above that can be checked offline.
