# x402 Agent MCP Server

This repository includes a standalone Model Context Protocol (MCP) server that empowers any MCP-compatible agent to discover, verify, and call paid x402 endpoints natively. It transforms paid API integration from a manual coding task into a simple tool call.

## Features

- **Agent-facing Discovery**: Exposes the facilitator catalog directly to the agent's context, as tools, as semantic resources, and as prompt templates.
- **Automated Payment Negotiation**: Handles HTTP 402 responses, `x402` payload signing, and payment injection transparently.
- **Hard Spending Controls**: Enforces strict per-call and per-session max spending limits, rejecting any over-budget calls before money is moved.
- **Secure Key Custody**: Key is provided at startup via environment variable and is never logged or exposed to the model.
- **Injection-hardened Context**: Seller-controlled catalog text is stripped of invisible characters and framed as quoted data before it can reach a model's instructions.

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

## Semantic Discovery

Tools take arguments and return JSON; the same catalog is also exposed through
the other two halves of MCP, for clients that prefer to attach context rather
than call a function.

> The `prompts` and `resources` capabilities appear in `initialize` only when the
> server can actually serve them. `resources` additionally requires
> `FACILITATOR_URL` to be configured, since an `x402://catalog/...` URI is
> resolved into a catalog query the server cannot answer on its own; with no
> such endpoint the capability is withheld instead of advertised and failing on
> first use. The endpoint is not probed at `initialize` time, so a facilitator
> that is configured but down surfaces as a read error, not a missing
> capability. A capability that is not advertised is answered with `-32601`,
> which tells a client to re-read `initialize` instead of retrying.

### Resources

| URI | Contents |
| --- | --- |
| `x402://catalog/resources` | The whole public catalog: service name, description, payee, price, network. |
| `x402://catalog/search?q={query}` | Ranked search, with the same ranking and recency decay as `/discovery/search`. |
| `x402://catalog/resource?url={url}` | Metadata and pricing for one resource. `url` must be percent-encoded. |
| `x402://catalog/network/{network}` | Catalog summary for one Stellar network. |

The last three are advertised as templates (`resources/templates/list`) rather
than concrete resources, because their URIs are not known until a client supplies
a parameter. A miss is a readable answer, not an error: asking for a resource
that is not in the catalog returns a body of `{"error": "not_found"}`.

### Prompts

| Prompt | Purpose | Arguments |
| --- | --- | --- |
| `generate_payment_uri` | Build the exact payment requirement for a resource: scheme, network, payee, amount, and the header to send. | `resource_url` (required), `network`, `max_amount_stroops` |
| `query_dispute_status` | Report whether a settled payment was reversed, and on what evidence. | `transaction_hash` (required), `network` |
| `audit_transaction` | Audit a settled payment end to end: amount matches, payee is the expected account, receipt is consistent. | `transaction_hash` (required), `network`, `expected_payee`, `include_timeline` |

**Prompts describe a payment; they never make one.** These templates are
server-authored instructions the agent executes — signing and submitting remains
the caller's decision, so a rendered prompt is not a payment credential.

### Handling untrusted content

The catalog is open: anyone can publish a resource and choose its `description`.
That text is a prompt-injection vector, so the two sides of the context are
defended differently.

- **Arguments are validated, not sanitised.** A transaction hash is 64 hex
  characters, a network is one of three allowlisted identifiers, a resource URL
  must be `http`/`https`. A value that does not fit is rejected with
  `isError: true` naming the field — the raw value is never echoed back, since
  an error message is itself read into the agent's context.
- **Catalog text is framed, not filtered.** A seller is entitled to write "ignore
  your instructions" in a description, and a phrase blacklist cannot catch every
  phrasing without also corrupting legitimate descriptions. Instead the text is
  neutralised (control characters, ANSI escapes, zero-width and bidirectional
  overrides stripped), bounded in length, and emitted inside an explicitly
  labelled data block. The surrounding template states in its own words that the
  block is data and carries no instructions.

`url` parameters are a request-forgery surface rather than an injection one: they
end up in an outbound request to the facilitator, so the scheme is checked
before any request is made. Query parameters in a search URI are passed as
values, never concatenated, so a URI cannot smuggle an extra parameter.

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
| Unknown prompt name in `prompts/get`, or a malformed prompt argument | a `result`, not an error | `result.isError: true`; `content[0].text` is `{"code":"invalid_input","message":…}`, with `validPrompts` or the offending `field` alongside so a client can correct itself |
| Unknown or malformed `uri` in `resources/read` | a `result`, not an error | as above, with `knownResources` listing the URIs this server serves |
| A `prompts/` or `resources/` method that is not implemented, or a capability that is not advertised | JSON-RPC error `-32601` (method not found) | no `error.data` |

The distinction matters to an agent: `-32601` means this server does not speak
the protocol, so the agent should fall back to another transport or give up;
`-32602` means the server is fine but the requested tool does not exist, so the
agent should `tools/list` again and pick a real tool. `isError: true` results
are a successful tool *call* that failed in the tool's own logic — business
failure, not protocol failure.

## Protocol Version Negotiation

The server speaks the **handshake-era** revisions of MCP, oldest first:

| Revision | Status |
| --- | --- |
| `2024-11-05` | supported |
| `2025-03-26` | supported |
| `2025-06-18` | supported |
| `2025-11-25` | supported — the newest revision reachable via `initialize`, and therefore the server's counter-offer |

The tools surface this server implements (`initialize`, `tools/list`,
`tools/call`, `ping`, `notifications/initialized`) is the same in all four, so
the revision the client asked for is the revision it gets back. The rules
(`initialize` follows the spec's negotiation section):

| Client sends in `params.protocolVersion` | Server answers with |
| --- | --- |
| a revision in the table above | **that same revision** — the connection will use it |
| a revision the server does not implement (including a malformed, non-string value) | `2025-11-25`, plus a warning on stderr naming the requested version and the list above, so the negotiation attempt is visible rather than silent |
| nothing at all | `2025-11-25` |

The revision is *negotiated*, not asserted: a client that cannot speak the
counter-offer is expected to disconnect rather than continue, and the warning
line is what tells an operator which revision was asked for. The modern
(no-handshake) era of MCP is out of scope for this stdio server — those clients
never send `initialize`, so there is nothing here to negotiate with them.

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

A JSON array is a JSON-RPC 2.0 batch (#428) and is answered with a single JSON
array of responses, on both the stdio and HTTP (`POST /mcp`) transports:

- Members run **concurrently** and fail independently; a tool error, unknown
  method or invalid member never affects its neighbours.
- Each response carries the `id` of the request it answers, in request order.
- Notifications (no `id`) get no response; a batch of only notifications
  produces no output (HTTP: `204`).
- A batch larger than **25** requests is refused whole. The limit is the
  `maxBatchSize` option of `McpServer`.

Every malformed frame is answered, so a client can never time out waiting on
something the server refused to understand:

| Input | Response |
| --- | --- |
| `[]` | single `-32600` error, `id: null` ("batch must not be empty") |
| More than 25 requests | single `-32600` error, `id: null`, naming the limit |
| A batch member that is not an object with a string `method` | `-32600` entry for that member (its `id` if detectable, else `null`); the others still run |
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
