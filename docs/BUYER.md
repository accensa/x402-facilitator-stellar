# Buyer / Agent Guide: discover, pay, and call paid endpoints on Stellar testnet

This guide is for anyone whose agent (or code) needs to find and pay for x402-protected
resources on Stellar testnet. It covers the full agent loop — discover, pay, retry —
with a copy-pasteable script, what to do with **every** rejection code the facilitator
can emit, and the MCP route for agent runtimes.

By the end you will have:

1. A funded Stellar testnet account that can pay.
2. A working discover-pay-retry loop against a live paid endpoint.
3. The MCP server wired up so any MCP-capable agent can find and call paid resources.

---


## Trustlines

On Stellar an account can only hold — and therefore only spend — an issued asset (USDC, any SEP-41 token) once it has authorized the issuer with a **trustline** (`changeTrust`). Native XLM needs no trustline. The facilitator sponsors the network fee, so the buyer needs **only the payment asset**: the XLM for transaction fees is paid by the facilitator, but the payment asset itself must be trusted *and funded* on your account.

- **Testnet:** `npm run fund:testnet` funds a fresh account and opens the USDC trustline on it in one step. If the seller prices in a different asset, add a trustline for that asset the same way (a `changeTrust` for that issuer).
- **Mainnet:** the same `changeTrust` operation, with the mainnet network passphrase and the issuer of the asset the listing actually prices in. Friendbot does not exist on pubnet — funding comes from an exchange withdrawal or an account that already holds the asset.

The most common first-payment failure on Stellar is a missing trustline on either side of the transfer. When you hit it, the transaction dies in simulation and reads as a generic failure; checking the listing's `asset` and confirming both accounts trust it is the fix.

## 0. Prerequisites

- **Node.js ≥ 20**.
- **A facilitator to query.** `http://localhost:3402` if you run the one in this repo
  ([`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)), or a hosted URL.
- **Something paid to call.** Either run the seller example
  ([`examples/http-seller`](../examples/http-seller)) so its `/api/joke` endpoint is
  live and catalogued, or search the facilitator's catalog for whatever you want.

Testnet accounts are free via friendbot; nothing on this page spends real money.

---

## 1. Fund a testnet account

Your agent pays with a Stellar account that holds the payment asset. Friendbot funds
XLM instantly:

```bash
stellar keys generate agent --network testnet --fund
stellar keys show agent --secret   # the S... secret, used everywhere below
```

The buyer guide's examples use the environment variable `AGENT_PAYER_SECRET_KEY` for
that secret. If the resource you are buying is priced in USDC, your account also needs
a USDC trustline and a few USDC — see the trustline snippet in
[`docs/SELLER.md`](./SELLER.md#2-trustlines-what-your-account-must-hold) (it applies to
the payer too). Friendbot does not fund USDC, so for USDC-priced testnet resources you
need testnet USDC from Circle's faucet or a friend who has it.

---

## 2. Discover a resource

Discovery is unauthenticated and open by design — agents browse before they hold any
key ([`docs/AUTHENTICATION.md`](./AUTHENTICATION.md)).

**Search** (lexical full-text, ranked by provenance and recency):

```bash
curl -s "http://localhost:3402/discovery/search?query=joke" | jq '.resources[] | {url, serviceName, pricing}'
```

**List with filters** (type, payTo, scheme, network, extensions):

```bash
curl -s "http://localhost:3402/discovery/resources?type=http&network=stellar:testnet&limit=10" | jq '.items[] | {url, serviceName, pricing}'
```

The catalog is populated automatically off the payment path when a seller's endpoint
declares the `bazaar` extension, so a listing here means real money has already moved
for that resource — payment-verified listings outrank manually registered ones
([`docs/BAZAAR.md`](./BAZAAR.md) for the ranking model).

Read the returned `pricing` before you pay: `asset` is the SEP-41 contract, `amount` is
in **stroops** (1 XLM = 10,000,000 stroops).

---

## 3. The discover-pay-retry loop

The protocol: your first request is unpaid and comes back `402 Payment Required` with
terms; you sign a payment authorization for exactly those terms; you retry with the
signature and get the resource. The facilitator verifies and settles on-chain — and
sponsors the fee, so you only need the payment asset.

This script is the whole loop, using the same client API the repo's own MCP server uses
([`src/mcp/cli.js`](../src/mcp/cli.js)):

```bash
# pay-and-call.mjs — run with:
#   AGENT_PAYER_SECRET_KEY=S... RESOURCE_URL=http://localhost:3401/api/joke node pay-and-call.mjs
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactStellarScheme as ExactStellarClient } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';

const FACILITATOR_URL = process.env.FACILITATOR_URL || 'http://localhost:3402';
const NETWORK = 'stellar:testnet';
const SECRET = process.env.AGENT_PAYER_SECRET_KEY;
const URL = process.env.RESOURCE_URL;
// The seller example prices in XLM; the XLM SAC must be opted into the SDK's
// client-side spend controls (default assets like USDC are allowed out of the
// box). List any other asset you intend to pay for here.
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
if (!SECRET || !URL) {
  console.error('AGENT_PAYER_SECRET_KEY and RESOURCE_URL are required');
  process.exit(1);
}

// 1. Wire the client: payer signer -> exact scheme -> HTTP transport.
const payer = createEd25519Signer(SECRET, NETWORK);
const client = new x402Client()
  .register(NETWORK, new ExactStellarClient(payer))
  .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: XLM_SAC }] });
const httpClient = new x402HTTPClient(client);

// 2. Unpaid request — expect 402 with terms.
const unpaid = await fetch(URL);
if (unpaid.status !== 402) {
  console.log(`Not gated (HTTP ${unpaid.status}) — nothing to pay.`);
  process.exit(0);
}

// 3. Parse the payment requirements out of the 402.
const paymentRequired = httpClient.getPaymentRequiredResponse(
  name => unpaid.headers.get(name),
  await unpaid.clone().json(),
);
const req0 = paymentRequired.accepts?.[0];
console.log('Terms:', JSON.stringify(req0, null, 2));

// 4. Sign a payment authorization for those terms.
const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);

// 5. Retry with the payment signature.
const paid = await fetch(URL, {
  headers: httpClient.encodePaymentSignatureHeader(paymentPayload),
});

// 6. Read the settlement outcome the facilitator reported.
const settle = httpClient.getPaymentSettleResponse(name => paid.headers.get(name));
console.log('Settlement:', JSON.stringify(settle, null, 2));

if (paid.status !== 200) {
  console.error(`Paid request failed: HTTP ${paid.status} — ${settle?.errorReason ?? 'unknown'}`);
  process.exit(1);
}
console.log('Resource:', await paid.text());
console.log('Tx: https://stellar.expert/explorer/testnet/tx/' + (settle?.transaction ?? ''));
```

Run it against the seller example:

```bash
AGENT_PAYER_SECRET_KEY=S... RESOURCE_URL=http://localhost:3401/api/joke node pay-and-call.mjs
```

You should see the 402 terms, then a settlement object with a transaction hash, then the
joke. The transaction hash is the receipt — verify it yourself:

```bash
curl -s https://horizon-testnet.stellar.org/transactions/<tx-hash> | jq '{successful, ledger, created_at}'
```

### The retry discipline

The loop is **verify-then-settle**: the resource server calls the facilitator's
`/verify` first (is this authorization valid?), then `/settle` (submit it on-chain).
Your client only sees the final response. If the first `POST /verify` says
`isValid: false`, the payment never reached the chain — fix what the reason code names
and retry. If `/settle` succeeds, the money moved; if it reports
`submitted_outcome_unknown`, the outcome is unknowable from the response — check the
transaction hash on-chain before you ever resubmit (resubmitting a settled payment is
how double-payment bugs happen).

---

## 4. Handling every rejection code

Every non-success response carries a stable reason code — the facilitator's own, or one
forwarded from the upstream `@x402/stellar` scheme. This is the decision table, grouped
by what your agent should do. The full taxonomy lives in
[`docs/REASONS.md`](./REASONS.md).

### Retryable — back off and retry

| Code | When | Action |
| --- | --- | --- |
| `rate_limited` | Exceeded a rate limit on `/verify`/`/settle` | Read `Retry-After` (seconds) from the response headers and wait exactly that long. |
| `catalog_rate_limited` | Exceeded the cataloguing bucket | Wait and retry. |
| `soroban_rpc_unreachable` | The chain is unreachable or the RPC circuit breaker is open | Exponential backoff and retry; this is an infrastructure outage, not a payment problem. |
| `request_timeout` | The facilitator gave up waiting for the chain | Retry. |
| `lock_timeout` | Settlement serialization lock was busy | Retry the `/settle` request. |
| `facilitator_error` | Internal error above the scheme layer | Check server logs if you operate it; backoff and retry. |
| `internal_error` | Unhandled server error | Backoff and retry. |
| `invalid_exact_stellar_payload_simulation_failed` | The simulated transaction failed on the RPC node | Review balances and trustlines (the common cause: missing trustline for the priced asset), then retry. |

### Not retryable — the request is wrong, fix it

| Code | Meaning | Action |
| --- | --- | --- |
| `invalid_request` | Body malformed or missing required fields | Fix the request payload format. |
| `missing_auth_header` / `malformed_auth_header` / `invalid_api_key` | Caller-authentication problem (for the API-key routes) | Provide a valid key in the `Authorization` header in the documented form. |
| `open_mode_usage_forbidden` | `/usage` called while the facilitator runs open | Only relevant if you operate the facilitator; it refuses to meter nobody. |
| `invalid_x402_version` | Unsupported protocol version | Upgrade/downgrade the payload version. |
| `invalid_network` | Network not served by this instance | Target a supported network (`stellar:testnet` or `stellar:pubnet`). |
| `invalid_exact_stellar_payload_malformed` | The Stellar payload cannot be parsed | Fix the base64 XDR. |
| `invalid_exact_stellar_payload_wrong_operation` | Wrong operation type | Only `InvokeHostFunction` is accepted. |
| `invalid_exact_stellar_payload_unsafe_tx_or_op_source` | Unsafe source account | The source must be the payer. |
| `invalid_exact_stellar_payload_wrong_asset` | Wrong asset transferred | Transfer exactly the asset in the payment requirements. |
| `invalid_exact_stellar_payload_wrong_function_name` | Wrong Soroban function | Must be `transfer`. |
| `invalid_exact_stellar_payload_facilitator_is_payer` | Facilitator set as payer | Payer must be the client's own address. |
| `invalid_exact_stellar_payload_wrong_recipient` | Wrong recipient | Transfer exactly to the requested `payTo`. |
| `invalid_exact_stellar_payload_wrong_amount` | Wrong amount | Transfer exactly the requested amount. |
| `invalid_exact_stellar_payload_fee_exceeds_maximum` | Simulated fee over the maximum | Rebuild with lower fee requirements. |
| `invalid_exact_stellar_payload_event_*` | Simulated events did not match a single expected transfer (wrong contract, asset, from, to, amount, multiple transfers, missing transfer) | The transaction must transfer the priced asset exactly once, exactly as declared. |
| `invalid_exact_stellar_payload_no_auth_entries` | Invocation unsigned | Sign the invocation. |
| `invalid_exact_stellar_payload_unsupported_credential_type` | Bad credential | Use a standard Soroban credential. |
| `invalid_exact_stellar_payload_facilitator_in_auth` | Facilitator in auth entries | The facilitator adds its own; don't include it. |
| `invalid_exact_stellar_signature_expiration_too_far` | Expiration beyond the maximum ledger | Lower the expiration ledger. |
| `invalid_exact_stellar_payload_has_subinvocations` | Sub-invocations present | Remove them. |
| `invalid_exact_stellar_payload_missing_payer_signature` | Payer did not sign | Sign the authorization. |
| `invalid_exact_stellar_payload_unexpected_pending_signatures` | Extra pending signatures | Only the payer's should be pending. |
| `invalid_exact_stellar_payload_authorization_not_signed` | Authorization not signed | Provide the auth signature. |
| `invalid_resource` / `catalog_error` | Cataloguing problems on manual registration | Fix the resource payload / check logs. |

### Special: do not blindly resubmit

| Code | Meaning | Action |
| --- | --- | --- |
| `submitted_outcome_unknown` | Settlement submitted to the network but the facilitator timed out waiting for confirmation | **Do NOT resubmit blindly.** Look up the returned `transaction` hash on-chain; if it settled, you are done — resubmitting risks paying twice. |

---

## 5. The MCP route for agent runtimes

Rather than writing the loop yourself, an MCP-capable agent can use this repo's
standalone MCP server ([`src/mcp/cli.js`](../src/mcp/cli.js),
[`docs/MCP.md`](./MCP.md)). It exposes three tools:

- **`search_resources`** (free) — search the facilitator catalog with natural language.
- **`get_resource`** (free) — full metadata and pricing for a specific URL.
- **`call_paid_resource`** (paid) — does the entire 402 negotiation and payment
  automatically, **spending money up to your configured caps**.

Configure it for Claude Desktop:

```json
{
  "mcpServers": {
    "x402-stellar": {
      "command": "node",
      "args": ["/path/to/x402-facilitator-stellar/src/mcp/cli.js"],
      "env": {
        "AGENT_PAYER_SECRET_KEY": "S...YOUR_TESTNET_KEY...",
        "MAX_FEE_PER_CALL_STROOPS": "1000",
        "MAX_SESSION_SPEND_STROOPS": "50000",
        "FACILITATOR_URL": "http://localhost:3402"
      }
    }
  }
}
```

The **hard spending controls** are the part to trust: `MAX_FEE_PER_CALL_STROOPS`
(default `1000` stroops = 0.0001 XLM) bounds any single call, `MAX_SESSION_SPEND_STROOPS`
(default `10000`) bounds the session, and a refusal happens **before** any money moves.
The worked example [`examples/mcp-agent`](../examples/mcp-agent) runs the whole loop —
discover, refused call (deliberately under-budgeted), successful call — and prints the
settled transaction hash:

```bash
cd examples/mcp-agent
npm install
npm start   # requires the facilitator AND the http-seller example running
```

---

## 6. Going further

- **Spending controls in your own loop** — the script in §3 signs exactly the terms the
  server offered; never sign terms you did not read. Check `maxAmountRequired` against
  your budget before signing (that is what the MCP server's `assertCanSpend` does).
- **Smart-account payers** — multi-sig and smart accounts work; see
  [`docs/REASONS.md`](./REASONS.md) for how the scheme treats auth entries.
- **Operator's view** — why some of the codes above look the way they do, and what the
  facilitator does when its RPC is down, is in [`docs/OPERATIONS.md`](./OPERATIONS.md).

## Reference

- [`examples/mcp-agent`](../examples/mcp-agent) — the worked MCP agent loop.
- [`docs/MCP.md`](./MCP.md) — MCP server configuration and tools.
- [`docs/BAZAAR.md`](./BAZAAR.md) — catalog endpoints, filters, ranking.
- [`docs/REASONS.md`](./REASONS.md) — the exhaustive rejection taxonomy.
