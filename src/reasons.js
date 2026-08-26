export const LOCAL_REASONS = Object.freeze({
  invalid_request:
    'The request body is malformed, missing required fields, or structurally impossible.',
  facilitator_error: 'An internal error occurred above the payment scheme processing layer.',
  missing_auth_header: 'The Authorization header is missing from the request.',
  malformed_auth_header: 'The Authorization header is malformed or invalid.',
  invalid_api_key: 'The provided API key is invalid or unauthorized.',
  open_mode_usage_forbidden:
    'The /usage route requires an API key, but the server is running in open mode.',
  rate_limited: 'The caller has exceeded their request rate limit.',
  catalog_rate_limited: 'The caller has exceeded their cataloging rate limit.',
  catalog_partial: 'The resource was cataloged, but some optional fields were dropped.',
  catalog_success: 'The resource was successfully cataloged.',
  invalid_resource: 'The resource payload is invalid for cataloging.',
  catalog_error: 'An internal error occurred while cataloging the resource.',
  internal_error: 'An internal server error occurred.',
  soroban_rpc_unreachable: 'The Stellar RPC node is unreachable or the circuit breaker is open.',
  lock_timeout: 'Timed out acquiring the distributed lock for settlement.',
  request_timeout: 'The request timed out before completing.',
  submitted_outcome_unknown:
    'The settlement was submitted to the network, but timed out waiting for confirmation.',
});

export const UPSTREAM_REASONS = Object.freeze({
  invalid_x402_version: 'The x402 protocol version is unsupported.',
  invalid_network: 'The specified network is unsupported.',
  invalid_exact_stellar_payload_malformed: 'The Stellar payload is malformed or cannot be parsed.',
  invalid_exact_stellar_payload_wrong_operation:
    'The Stellar transaction contains the wrong operation type.',
  invalid_exact_stellar_payload_unsafe_tx_or_op_source:
    'The Stellar transaction uses an unsafe source account.',
  invalid_exact_stellar_payload_wrong_asset: 'The Stellar transaction transfers the wrong asset.',
  invalid_exact_stellar_payload_wrong_function_name:
    'The Soroban contract invocation uses the wrong function name.',
  invalid_exact_stellar_payload_facilitator_is_payer:
    'The facilitator address is improperly set as the payer.',
  invalid_exact_stellar_payload_wrong_recipient:
    'The Stellar transaction transfers funds to the wrong recipient.',
  invalid_exact_stellar_payload_wrong_amount: 'The Stellar transaction transfers the wrong amount.',
  invalid_exact_stellar_payload_simulation_failed:
    'The Stellar transaction failed simulation on the RPC node.',
  invalid_exact_stellar_payload_fee_exceeds_maximum:
    'The simulated transaction fee exceeds the maximum allowed fee.',
  invalid_exact_stellar_payload_event_not_transfer:
    'The simulated transaction emitted an unexpected event type (not a transfer).',
  invalid_exact_stellar_payload_event_missing_contract_id:
    'The simulated transaction emitted an event missing the contract ID.',
  invalid_exact_stellar_payload_event_wrong_asset:
    'The simulated transfer event involved the wrong asset contract.',
  invalid_exact_stellar_payload_no_transfer_events:
    'The simulated transaction did not emit any transfer events.',
  invalid_exact_stellar_payload_multiple_transfers:
    'The simulated transaction emitted multiple transfer events.',
  invalid_exact_stellar_payload_event_wrong_from:
    'The simulated transfer event originated from the wrong address.',
  invalid_exact_stellar_payload_event_wrong_to:
    'The simulated transfer event was directed to the wrong recipient.',
  invalid_exact_stellar_payload_event_wrong_amount:
    'The simulated transfer event transferred the wrong amount.',
  invalid_exact_stellar_payload_no_auth_entries:
    'The Soroban invocation is missing authorization entries.',
  invalid_exact_stellar_payload_unsupported_credential_type:
    'The authorization entry uses an unsupported credential type.',
  invalid_exact_stellar_payload_facilitator_in_auth:
    'The facilitator address is improperly present in authorization entries.',
  invalid_exact_stellar_signature_expiration_too_far:
    'The authorization signature expires too far in the future.',
  invalid_exact_stellar_payload_has_subinvocations:
    'The Soroban invocation contains unsupported sub-invocations.',
  invalid_exact_stellar_payload_missing_payer_signature:
    'The Soroban invocation is missing the payer signature.',
  invalid_exact_stellar_payload_unexpected_pending_signatures:
    'The Soroban invocation has unexpected pending signatures.',
  invalid_exact_stellar_payload_authorization_not_signed:
    'The Soroban invocation authorization is not signed.',
});
