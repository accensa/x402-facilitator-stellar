# Stellar `upto` Scheme Specification

**Status:** Draft / Upstream Contribution  
**TSC Thread:** [TSC Thread (x402/stellar#000)](https://github.com/x402/stellar/pull/000)  
**Dependency:** Blocked on `accensa-contracts` [ADR-002](https://github.com/accensa/accensa-contracts/issues/2) (Contract vs Contract-free design)

This document defines the `stellar` network implementation for the x402 `upto` scheme. It adheres to the standard x402 network specification format, mapping abstract `upto` concepts—authorizing a maximum spend but settling actual usage—to Stellar primitives.

## 1. Network Identifier
The network identifier MUST be `stellar:mainnet`, `stellar:testnet`, or `stellar:futurenet`.

## 2. Payload Shape
The client provides a payload to the facilitator during verification containing an authorized spend cap.

```json
{
  "x402Version": 2,
  "scheme": "upto",
  "network": "stellar:testnet",
  "payload": {
    "authEntry": "AAAA...", 
    "maxAmountRequired": "50000000",
    "signatureExpirationLedger": 450000
  }
}
```

## 3. Stellar Specifics

### 3.1. Auth Entries vs Pre-signed Transactions
Unlike EVM architectures relying on EIP-712 signatures, this scheme leverages **Soroban Auth Entries** (`SorobanAuthorizationEntry`). The client signs an auth entry authorizing the facilitator to invoke a contract (or perform a transfer) up to the specified `maxAmountRequired`. This avoids sequence-number contention entirely, as auth entries are valid regardless of the source account's sequence state, making it robust under agent burst workloads.

### 3.2. Expiry
The auth entry MUST define a `signatureExpirationLedger` rather than a timestamp. The facilitator verifies that the current ledger sequence is strictly less than this expiration before accepting the payment.

### 3.3. Trustlines
Tokens on Stellar (both Classic and Soroban wrappers) require the recipient to have established a trustline for the asset. If the facilitator (or recipient) lacks a trustline for the asset defined in the `paymentRequirements`, the payment MUST be rejected during `/verify`.

### 3.4. Resource Limits
Soroban transactions must explicitly declare their resource limits (CPU, memory, read/write). The facilitator is responsible for wrapping the client's auth entry into a transaction, funding the fee, and estimating the required resources before submission.

## 4. Smart Account Spending Policies
A core advantage of Stellar smart wallets (smart accounts) is the ability to define granular spending policies. An agent acting on behalf of a user can be issued a session key bounded by an on-chain policy (e.g., "Max 50 XLM per day").
The `upto` scheme composes naturally with this: the agent signs the auth entry using its session key. When the facilitator submits the transaction, the smart wallet contract natively enforces the spending policy, rejecting the transaction if the `maxAmountRequired` or cumulative spend exceeds the policy limits.

## 5. Trust Model
*(Note: Pending finalization of ADR-002)*

Currently, the `upto` scheme is designed to ship **contract-free**. 
**Weakened Trust Model:** Because there is no Soroban contract holding funds in escrow, the facilitator directly executes the transfer using the provided auth entry. The client must trust the facilitator to only charge for actual usage (the metered amount) and not drain up to the `maxAmountRequired`. If the facilitator acts maliciously, they can charge the full cap. This is a weaker trust model compared to an on-chain escrow contract but is significantly cheaper and faster to execute.

