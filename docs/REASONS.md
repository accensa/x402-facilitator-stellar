# Rejection Reason Taxonomy

The `x402-facilitator-stellar` service strictly types its rejection and failure reasons. When an endpoint returns a non-success response (e.g., `isValid: false`), it includes a stable `invalidReason` (or `errorReason` for `/settle`) indicating the exact cause, allowing the client to determine whether a request is retryable or requires user intervention.

Reasons are separated into **Local Transport Reasons** (emitted by this server) and **Upstream Scheme Reasons** (emitted by the `@x402/stellar` protocol library).

## Local Transport Reasons

| Code | Meaning | Retryable? | Caller Action |
| --- | --- | --- | --- |
| `invalid_request` | The request body is malformed, missing required fields, or structurally impossible. | ❌ No | Fix request payload format |
| `facilitator_error` | An internal error occurred above the payment scheme processing layer. | ⚠️ Maybe | Check server logs; backoff and retry |
| `missing_auth_header` | The Authorization header is missing from the request. | ❌ No | Include a valid API key |
| `malformed_auth_header` | The Authorization header is malformed or invalid. | ❌ No | Fix header format (Bearer token) |
| `invalid_api_key` | The provided API key is invalid or unauthorized. | ❌ No | Verify your API key |
| `open_mode_usage_forbidden` | The `/usage` route requires an API key, but the server is running in open mode. | ❌ No | Run the facilitator in authenticated mode |
| `rate_limited` | The caller has exceeded their request rate limit. | ✅ Yes | Wait for `Retry-After` seconds and retry |
| `catalog_rate_limited` | The caller has exceeded their cataloging rate limit. | ✅ Yes | Wait and retry |
| `catalog_partial` | The resource was cataloged, but some optional fields were dropped. | ❌ No | Check formatting of dropped fields |
| `catalog_success` | The resource was successfully cataloged. | - | None (Not a rejection) |
| `invalid_resource` | The resource payload is invalid for cataloging. | ❌ No | Fix payload format |
| `catalog_error` | An internal error occurred while cataloging the resource. | ⚠️ Maybe | Check logs; retry |
| `internal_error` | An internal server error occurred. | ⚠️ Maybe | Backoff and retry |
| `soroban_rpc_unreachable` | The Stellar RPC node is unreachable or the circuit breaker is open. | ✅ Yes | Exponential backoff and retry |
| `lock_timeout` | Timed out acquiring the distributed lock for settlement. | ✅ Yes | Retry the `/settle` request |
| `request_timeout` | The request timed out before completing. | ✅ Yes | Retry the request |
| `submitted_outcome_unknown` | The settlement was submitted to the network, but timed out waiting for confirmation. | ⚠️ Maybe | Do NOT resubmit blindly; check transaction hash status on-chain |

## Upstream Scheme Reasons (`@x402/stellar`)

These reasons are forwarded directly from the underlying protocol scheme implementation.

| Code | Meaning | Retryable? | Caller Action |
| --- | --- | --- | --- |
| `invalid_x402_version` | The x402 protocol version is unsupported. | ❌ No | Upgrade/Downgrade payload version |
| `invalid_network` | The specified network is unsupported. | ❌ No | Target a supported Stellar network |
| `invalid_exact_stellar_payload_malformed` | The Stellar payload is malformed or cannot be parsed. | ❌ No | Fix the base64 XDR |
| `invalid_exact_stellar_payload_wrong_operation` | The Stellar transaction contains the wrong operation type. | ❌ No | Only use InvokeHostFunction |
| `invalid_exact_stellar_payload_unsafe_tx_or_op_source` | The Stellar transaction uses an unsafe source account. | ❌ No | Ensure source account is the payer |
| `invalid_exact_stellar_payload_wrong_asset` | The Stellar transaction transfers the wrong asset. | ❌ No | Transfer the asset requested in payment requirements |
| `invalid_exact_stellar_payload_wrong_function_name` | The Soroban contract invocation uses the wrong function name. | ❌ No | Ensure function name is `transfer` |
| `invalid_exact_stellar_payload_facilitator_is_payer` | The facilitator address is improperly set as the payer. | ❌ No | Payer must be the client's address |
| `invalid_exact_stellar_payload_wrong_recipient` | The Stellar transaction transfers funds to the wrong recipient. | ❌ No | Transfer exactly to the requested payee |
| `invalid_exact_stellar_payload_wrong_amount` | The Stellar transaction transfers the wrong amount. | ❌ No | Transfer exactly the requested amount |
| `invalid_exact_stellar_payload_simulation_failed` | The Stellar transaction failed simulation on the RPC node. | ⚠️ Maybe | Review balances and state |
| `invalid_exact_stellar_payload_fee_exceeds_maximum` | The simulated transaction fee exceeds the maximum allowed fee. | ❌ No | Re-build transaction with lower fee requirements |
| `invalid_exact_stellar_payload_event_not_transfer` | The simulated transaction emitted an unexpected event type (not a transfer). | ❌ No | Ensure contract emits standard transfer event |
| `invalid_exact_stellar_payload_event_missing_contract_id` | The simulated transaction emitted an event missing the contract ID. | ❌ No | Ensure standard token contract is used |
| `invalid_exact_stellar_payload_event_wrong_asset` | The simulated transfer event involved the wrong asset contract. | ❌ No | Use the requested asset |
| `invalid_exact_stellar_payload_no_transfer_events` | The simulated transaction did not emit any transfer events. | ❌ No | Transaction must transfer funds |
| `invalid_exact_stellar_payload_multiple_transfers` | The simulated transaction emitted multiple transfer events. | ❌ No | Transaction must transfer funds exactly once |
| `invalid_exact_stellar_payload_event_wrong_from` | The simulated transfer event originated from the wrong address. | ❌ No | Payer must be the source |
| `invalid_exact_stellar_payload_event_wrong_to` | The simulated transfer event was directed to the wrong recipient. | ❌ No | Payee must be the destination |
| `invalid_exact_stellar_payload_event_wrong_amount` | The simulated transfer event transferred the wrong amount. | ❌ No | Transfer exactly the requested amount |
| `invalid_exact_stellar_payload_no_auth_entries` | The Soroban invocation is missing authorization entries. | ❌ No | Sign the invocation |
| `invalid_exact_stellar_payload_unsupported_credential_type` | The authorization entry uses an unsupported credential type. | ❌ No | Use a standard Soroban credential |
| `invalid_exact_stellar_payload_facilitator_in_auth` | The facilitator address is improperly present in authorization entries. | ❌ No | Facilitator will add its own auth entry |
| `invalid_exact_stellar_signature_expiration_too_far` | The authorization signature expires too far in the future. | ❌ No | Lower the expiration ledger |
| `invalid_exact_stellar_payload_has_subinvocations` | The Soroban invocation contains unsupported sub-invocations. | ❌ No | Remove sub-invocations |
| `invalid_exact_stellar_payload_missing_payer_signature` | The Soroban invocation is missing the payer signature. | ❌ No | Payer must sign the authorization |
| `invalid_exact_stellar_payload_unexpected_pending_signatures` | The Soroban invocation has unexpected pending signatures. | ❌ No | Only payer should leave a signature pending |
| `invalid_exact_stellar_payload_authorization_not_signed` | The Soroban invocation authorization is not signed. | ❌ No | Provide the auth signature |
