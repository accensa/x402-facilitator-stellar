# x402 Agent MCP Server

This repository includes a standalone Model Context Protocol (MCP) server that empowers any MCP-compatible agent to discover, verify, and call paid x402 endpoints natively. It transforms paid API integration from a manual coding task into a simple tool call.

## Features

- **Agent-facing Discovery**: Exposes the facilitator catalog directly to the agent's context.
- **Automated Payment Negotiation**: Handles HTTP 402 responses, `x402` payload signing, and payment injection transparently.
- **Hard Spending Controls**: Enforces strict per-call and per-session max spending limits, rejecting any over-budget calls before money is moved.
- **Secure Key Custody**: Key is provided at startup via environment variable and is never logged or exposed to the model.

## Installation & Configuration

The MCP server ships as the `x402-mcp` executable (with `validate-discovery`
alongside it) in the published package `@accensa/x402-facilitator-stellar`.

Install it from npm:

```bash
# Globally, so the `x402-mcp` command is on your PATH:
npm install -g @accensa/x402-facilitator-stellar

# Or run it without a global install:
npx -p @accensa/x402-facilitator-stellar x402-mcp
```

From a checkout, the same server can be run directly with Node:

```bash
node src/mcp/cli.js
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_PAYER_SECRET_KEY` | **(Required for `call_paid_resource`)** Stellar Ed25519 Secret Key to pay for API calls. | *none* |
| `MAX_FEE_PER_CALL_STROOPS` | Max amount willing to pay for a single API call (in stroops). | `1000` (0.0001 XLM) |
| `MAX_SESSION_SPEND_STROOPS`| Max amount willing to pay per session (in stroops). | `10000` (0.001 XLM) |
| `FACILITATOR_URL` | Facilitator endpoint for catalog discovery. | `http://localhost:3402` |
| `NETWORK` | Stellar network to use. | `stellar:testnet` |

### Adding to Claude Desktop

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-stellar": {
      "command": "x402-mcp",
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

## Available Tools

The MCP server exposes three tools to the agent:

1. **`search_resources` (Free)**: Search the facilitator's catalog using natural language and filters. Returns resource metadata including parameter descriptions.
2. **`get_resource` (Free)**: Get full metadata and pricing information for a specific resource URL.
3. **`call_paid_resource` (Paid)**: Call a paid endpoint. The tool handles the 402 negotiation and payment automatically. **This tool will spend money.**

## Error Contract

The MCP server follows the MCP spec's two-tier error handling, and the three
failure shapes a client can see are deliberately distinct:

| Situation | Response | Shape |
| --- | --- | --- |
| Unknown tool name in `tools/call` | JSON-RPC error `-32602` (invalid params) | `error.message` is `Unknown tool: <name>`; `error.data.validTools` is the list of tools this server actually has, so a client can re-read `tools/list` without a second round trip |
| Missing `name` parameter | JSON-RPC error `-32602` (invalid params) | `error.message` is `Unknown tool: (missing name)` |
| Unknown method (a request the server does not speak) | JSON-RPC error `-32601` (method not found) | no `error.data` |
| A tool's handler returns a deliberate error (`isToolError`) | a `result`, not an error | `result.isError: true` with the error detail in `content[0].text` |
| A tool's handler throws unexpectedly | JSON-RPC error `-32603` (internal error) | `error.message` carries the thrown message |

The distinction matters to an agent: `-32601` means this server does not speak
the protocol, so the agent should fall back to another transport or give up;
`-32602` means the server is fine but the requested tool does not exist, so the
agent should `tools/list` again and pick a real tool. `isError: true` results
are a successful tool *call* that failed in the tool's own logic — business
failure, not protocol failure.

## Transport behavior

The stdio transport is newline-delimited JSON-RPC 2.0. Around the error
contract above, the server keeps four transport-level promises:

- **Responses are serialized.** Requests are processed one line at a time, so
  response order always matches request order even though tool handlers are
  async. A slow `tools/call` (a large catalog listing) cannot be overtaken by
  a fast one issued after it.
- **Backpressure is honored.** Every write goes through a queue that stops
  when `write()` returns `false` and resumes on `drain`. A large response
  therefore cannot interleave with the response behind it inside Node's pipe
  buffer — two JSON objects sharing a line is an unparseable stream, not a
  late one.
- **A dead client is a clean stop, not a crash.** `EPIPE` on stdout (the agent
  disconnected mid-write) stops the server instead of raising an unhandled
  error event.
- **Notifications are never answered.** A request without an `id` produces no
  output — not on success, and not when its handler throws (the failure is
  logged instead). No emitted frame ever lacks its `id`.

### Batches

JSON-RPC 2.0 batch requests — a JSON array of requests, answered with an array
of responses — are **not supported**; the MCP protocol does not use them. They
are rejected explicitly rather than silently ignored, and every malformed
frame is answered, so a client can never time out waiting on something the
server refused to understand:

| Input | Response |
| --- | --- |
| Any JSON array (including `[]` and arrays of only notifications) | single `-32600` error whose message names that batches are not supported |
| Valid JSON that is not an object with a string `method` | `-32600` with `id: null` |
| A line that is not valid JSON | `-32700` "Parse error" with `id: null` |

## Worked Example

Agent prompt:
> "Find a weather API in the x402 catalog, get the forecast for London, and tell me if it will rain."

What the agent does:
1. Calls `search_resources` with `{"query": "weather forecast"}`.
2. Reads the returned parameters and pricing.
3. Calls `call_paid_resource` with `{"url": "...", "method": "GET"}`.
4. The MCP proxy intercepts the 402 response, signs the payment payload using `AGENT_PAYER_SECRET_KEY`, resubmits the request, and returns the weather data to the agent.
5. The agent responds to the user: "It will not rain in London today."
