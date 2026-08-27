#!/usr/bin/env node

import { McpServer } from './server.js';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactStellarScheme as ExactStellarClient } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'http://localhost:3402';
const AGENT_PAYER_SECRET_KEY = process.env.AGENT_PAYER_SECRET_KEY;
const NETWORK = process.env.NETWORK || 'stellar:testnet';

// Conservative defaults (in stroops: 1 XLM = 10_000_000 stroops).
// Default max per-call: 1000 stroops = 0.0001 XLM
// Default max per-session: 10000 stroops = 0.001 XLM
const MAX_FEE_PER_CALL_STROOPS = BigInt(process.env.MAX_FEE_PER_CALL_STROOPS || '1000');
const MAX_SESSION_SPEND_STROOPS = BigInt(process.env.MAX_SESSION_SPEND_STROOPS || '10000');

let sessionSpendStroops = 0n;

// Setup x402 client if key is provided
let x402HttpClient = null;
if (AGENT_PAYER_SECRET_KEY) {
  try {
    const payer = createEd25519Signer(AGENT_PAYER_SECRET_KEY, NETWORK);
    const client = new x402Client()
      .register(NETWORK, new ExactStellarClient(payer))
      // @x402/core >= 2.22 enforces client-side spend controls and by default
      // only pays "default" assets (USDC on Stellar). The MCP is a general
      // agent wallet whose real caps are MAX_FEE_PER_CALL_STROOPS /
      // MAX_SESSION_SPEND_STROOPS below — assertCanSpend refuses before any
      // money moves — so the SDK-level default would wrongly reject XLM-priced
      // resources (e.g. the repo's own seller example). Disable the SDK
      // controls; the MCP's own are the ones that matter here.
      .setSpendControls(false);
    x402HttpClient = new x402HTTPClient(client);
  } catch (err) {
    console.error(`Failed to initialize payer signer: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fetchDiscovery(path, params) {
  const url = new URL(`${FACILITATOR_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) {
          v.forEach(val => url.searchParams.append(k, val));
        } else {
          url.searchParams.append(k, String(v));
        }
      }
    }
  }

  const res = await fetch(url);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      if (errBody.invalidReason) msg = errBody.invalidReason;
    } catch {
      // Ignore parse errors from the error body
    }
    throw new Error(`Facilitator request failed: ${msg}`);
  }
  return res.json();
}

function assertCanSpend(amountStroops) {
  const amount = BigInt(amountStroops);
  if (amount > MAX_FEE_PER_CALL_STROOPS) {
    throw new Error(
      `Spending refused: Request amount (${amount} stroops) exceeds per-call limit (${MAX_FEE_PER_CALL_STROOPS} stroops).`,
    );
  }
  if (sessionSpendStroops + amount > MAX_SESSION_SPEND_STROOPS) {
    throw new Error(
      `Spending refused: Request amount (${amount} stroops) exceeds remaining session budget (spent ${sessionSpendStroops}/${MAX_SESSION_SPEND_STROOPS} stroops).`,
    );
  }
}

// ---------------------------------------------------------------------------
// MCP Server Initialization
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'x402-facilitator-stellar-mcp',
  version: '0.0.1',
});

// Tool 1: search_resources
server.tool(
  'search_resources',
  {
    description:
      'Search for x402 paid and free resources in the facilitator catalog. Does NOT spend money.',
    properties: {
      query: { type: 'string', description: 'Natural language search query' },
      limit: { type: 'number', description: 'Number of results to return (max 100)' },
      type: { type: 'string', description: 'Filter by resource type (e.g. "http", "mcp")' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required extensions (e.g. "bazaar")',
      },
      payTo: { type: 'string', description: 'Filter by payee Stellar account ID' },
      scheme: { type: 'string', description: 'Payment scheme (e.g. "exact")' },
      network: { type: 'string', description: 'Network identifier (e.g. "stellar:testnet")' },
    },
  },
  async args => {
    return await fetchDiscovery('/discovery/search', args);
  },
);

// Tool 2: get_resource
server.tool(
  'get_resource',
  {
    description:
      'Get full metadata and pricing information for a specific x402 resource. Does NOT spend money.',
    properties: {
      url: { type: 'string', description: 'Resource URL to fetch metadata for' },
      toolName: {
        type: 'string',
        description: 'Optional MCP tool name, required if the resource is an MCP tool',
      },
    },
    required: ['url'],
  },
  async args => {
    const res = await fetchDiscovery('/discovery/resources', {
      url: args.url,
      toolName: args.toolName,
    });
    if (!res.resources || res.resources.length === 0) {
      throw new Error(`Resource not found in catalog.`);
    }
    return res.resources[0];
  },
);

// Tool 3: call_paid_resource
server.tool(
  'call_paid_resource',
  {
    description:
      'Proxy tool that handles discovery, HTTP 402 negotiation, payment via x402, and retrieves the resource. This tool WILL SPEND MONEY up to your configured caps.',
    properties: {
      url: { type: 'string', description: 'The endpoint URL to call' },
      method: { type: 'string', description: 'HTTP method (default: GET)' },
      body: { type: 'string', description: 'JSON stringified body payload for POST/PUT requests' },
      maxFeeStroops: {
        type: 'string',
        description:
          'Maximum willing to pay in stroops for this specific call (optional). Still bounded by the global per-call cap.',
      },
    },
    required: ['url'],
  },
  async args => {
    if (!x402HttpClient) {
      throw new Error('call_paid_resource requires AGENT_PAYER_SECRET_KEY to be configured.');
    }

    const { url, method = 'GET', body, maxFeeStroops } = args;

    // 1. Initial Unpaid Request
    const options = { method };
    if (body) {
      options.body = body;
      options.headers = { 'Content-Type': 'application/json' };
    }

    const unpaidRes = await fetch(url, options);

    if (unpaidRes.status !== 402) {
      // Endpoint is not gated or we somehow bypassed it
      const text = await unpaidRes.text();
      return {
        success: true,
        status: unpaidRes.status,
        response: text,
      };
    }

    // 2. Parse 402 Payment Requirements
    const errBody = await unpaidRes
      .clone()
      .json()
      .catch(() => undefined);
    let paymentRequired;
    try {
      paymentRequired = x402HttpClient.getPaymentRequiredResponse(
        name => unpaidRes.headers.get(name),
        errBody,
      );
    } catch (err) {
      throw new Error(`Failed to parse payment requirements: ${err.message}`);
    }

    const req0 = paymentRequired.accepts?.[0];
    if (!req0) {
      throw new Error('Resource returned 402 but provided no payment accepts requirements.');
    }

    const amountStr = req0.maxAmountRequired || req0.price?.amount || '0';
    const amount = BigInt(amountStr);

    // 3. Spending Controls
    assertCanSpend(amount);
    if (maxFeeStroops && amount > BigInt(maxFeeStroops)) {
      throw new Error(
        `Spending refused: Request amount (${amount} stroops) exceeds requested maxFeeStroops (${maxFeeStroops}).`,
      );
    }

    // 4. Create Payment Payload & Sign
    let paymentPayload;
    try {
      paymentPayload = await x402HttpClient.createPaymentPayload(paymentRequired);
    } catch (err) {
      throw new Error(`Failed to create payment payload: ${err.message}`);
    }

    // 5. Send Paid Request
    const paidHeaders = {
      ...options.headers,
      ...x402HttpClient.encodePaymentSignatureHeader(paymentPayload),
    };

    const paidRes = await fetch(url, { ...options, headers: paidHeaders });
    const responseText = await paidRes.text();

    const settle = x402HttpClient.getPaymentSettleResponse(name => paidRes.headers.get(name));

    if (paidRes.status !== 200) {
      throw new Error(
        `Paid request failed (${paidRes.status}): ${settle?.errorReason || 'unknown'}. ${responseText.slice(0, 200)}`,
      );
    }

    // 6. Record Spend
    sessionSpendStroops += amount;

    return {
      success: true,
      settlement: settle,
      response: responseText,
    };
  },
);

// Start server
server.start();
