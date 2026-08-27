# x402 MCP Agent Simulation

This example demonstrates how an AI agent uses the `x402-mcp` standalone server to discover and call paid resources entirely autonomously.

When started, it automatically configures and funds a Stellar testnet account for the agent via Friendbot. It then spins up the local MCP server and runs through a simulated AI tool loop.

## ⚠️ Trustline prerequisite

The seller example this agent pays prices in **XLM**, the native asset, which needs **no trustline** — nothing to set up for the stock example. The trap is any USDC-priced resource: **the agent (buyer) needs a trustline for the payment asset and a balance of it** before the payment can settle, and the seller needs one to receive it. A missing trustline fails deep in transaction simulation and reads as a generic error, so establish it up front:

```bash
# From the repo root — funds three fresh testnet accounts AND opens a USDC
# trustline on each (see scripts/fund-testnet-accounts.mjs)
npm run fund:testnet
```

For an existing agent account, `npm run prepare:testnet-usdc` (with `CLIENT_STELLAR_PRIVATE_KEY` / `SERVER_STELLAR_ADDRESS` / `SERVER_STELLAR_PRIVATE_KEY` set) adds the USDC trustline and funds the payer — see the [Buyer / Agent Guide](../../docs/BUYER.md#trustlines) for the concept, both networks, and the exact commands.

## Prerequisites
- Node.js >= 20
- A running x402 Facilitator instance (`npm start` in the repo root).
- The HTTP Seller example running (`npm start` in `examples/http-seller`).

## How to run

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run the simulation:**
   ```bash
   npm start
   ```

## What happens

The script acts as a deterministic LLM planner interacting with the MCP server:

1. **Discovery**: It asks the MCP server to `search_resources` for the query `"joke"`.
2. **Refusal Path**: It finds the seller endpoint but intentionally sets a `maxFeeStroops` of 50. The MCP server intercepts this and refuses the transaction before it ever reaches the network.
3. **Success Path**: It attempts the call again with an adequate budget. The MCP server automatically:
   - Queries the resource (gets HTTP 402)
   - Parses the pricing and verifies the agent has enough budget
   - Builds an `x402` payment payload on the Stellar testnet
   - Signs it locally with the agent's payer key
   - Retries the request with the payment signature
   - Parses the result and settlement hash back to the agent

You will see the full transcript of this interaction printed to your console, including the transaction hash you can inspect on a public Stellar block explorer.
