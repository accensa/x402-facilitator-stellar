# Seller Guide: from zero to a paid, discoverable endpoint on Stellar testnet

This guide walks a seller from nothing to a live, paid, **catalogued** API endpoint on
Stellar testnet — the same path the RFP's "under an hour to a paid, discoverable
endpoint" claim rests on. Everything here is runnable on testnet today; the worked
example lives in [`examples/http-seller`](../examples/http-seller) and is what the
commands below walk through.

By the end you will have:

1. A Stellar testnet account that receives payment.
2. An HTTP endpoint that answers `402 Payment Required` with x402 terms, then serves
   the resource once those terms are paid.
3. A listing in the facilitator's discovery catalog (the Bazaar) that agents can find
   with `GET /discovery/search`.

Time: about 30 minutes, most of it installing packages.

---

## 0. Prerequisites

- **Node.js ≥ 20** (`node -v`).
- **A facilitator to point at.** Either the one in this repo, run locally
  ([`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — `FACILITATOR_SECRET` plus `npm start`
  serves it on `http://localhost:3402`), or a hosted facilitator URL if one is
  available to you. For testnet onboarding, open mode (no API keys) is the default and
  is fine.
- **A wallet tool or the `stellar` CLI** for account creation and trustlines. The
  example auto-creates and funds a fresh testnet account for you, but you should
  understand the account it is creating.

No mainnet funds, no payment card, nothing to sign up for. Testnet accounts are free
via friendbot.

---

## 1. The account that gets paid

Every paid resource declares a `payTo` address — the Stellar account that receives the
payment asset. In the example this is your merchant account, and the example creates
and funds it automatically:

```bash
cd examples/http-seller
npm install
npm start
```

On first run you will see something like:

```
No merchant account configured. Generating a new one and funding via friendbot...
Successfully funded GA4Z... via Friendbot.
Saved secret to .merchant-secret for future runs.
🚀 Paid API running at http://localhost:3401/api/joke
```

To create and fund such an account yourself (the CLI equivalent of what the example
does):

```bash
stellar keys generate seller --network testnet --fund
stellar keys show seller      # prints the public address; use it as payTo
stellar keys show seller --secret   # the S... secret, for .merchant-secret
```

The example reads `MERCHANT_SECRET` if set, then `.merchant-secret`, then generates.
If you want to reuse a specific account, set `MERCHANT_SECRET=S...` before `npm start`.

> **Testnet only.** Everything in this guide is testnet. The `S...` secrets here hold
> play money; the same steps on pubnet hold real money and the operational posture is
> different (see [OPERATOR.md](./OPERATOR.md) and
> [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)).

---

## 2. Trustlines: what your account must hold

The payment asset is what the buyer's authorization transfers. **Native XLM needs no
trustline** — every Stellar account can hold it. The example prices in XLM
(`0.00025 XLM`), which is why it runs with a fresh friendbot account and zero setup.

A SEP-41 token such as **USDC does require a trustline** on the receiving account, and
the payer's account needs one too. Testnet USDC parameters:

| | Value |
|---|---|
| Asset | `USDC` |
| Issuer | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| SEP-41 contract (what you put in `pricing.asset`) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

Create the trustline once, from the seller account:

```bash
# trustline-usdc.mjs — run with: SELLER_SECRET=S... node trustline-usdc.mjs
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const SECRET = process.env.SELLER_SECRET;
const kp = Keypair.fromSecret(SECRET);
const usdc = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const server = new Horizon.Server('https://horizon-testnet.stellar.org');

const account = await server.loadAccount(kp.publicKey());
const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.changeTrust({ asset: usdc, limit: '1000000' }))
  .setTimeout(60)
  .build();
tx.sign(kp);
const res = await server.submitTransaction(tx);
console.log('Trustline created:', res.hash);
```

If you ever see `invalid_exact_stellar_payload_simulation_failed` with a
`trustline entry is missing for account` error underneath, this is the cause: either
the seller or the payer lacks the trustline for the priced asset.

---

## 3. Declare the endpoint and its price

The x402 contract has three moving parts, all visible in
[`examples/http-seller/index.js`](../examples/http-seller/index.js):

1. **A resource server** that speaks the x402 payment protocol,
2. **a facilitator client** that points at your facilitator, and
3. **an Express app** with the paid route and its discovery metadata.

```js
import express from 'express';
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme as ExactStellarServer } from '@x402/stellar/exact/server';

const NETWORK = 'stellar:testnet';
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'; // native XLM on testnet
const PRICE_STROOPS = '2500'; // 0.00025 XLM  (1 XLM = 10_000_000 stroops)
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'http://localhost:3402';

const resourceServer = new x402ResourceServer([
  new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
]);
resourceServer.register(NETWORK, new ExactStellarServer());

const httpServer = new x402HTTPResourceServer(resourceServer, {
  '/api/joke': {
    title: 'Dad Joke Generator',
    description: 'Generates a random, completely unpredictable dad joke.',
    extensions: ['bazaar'],
    iconUrl: 'https://cdn-icons-png.flaticon.com/512/3260/3260838.png',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category. Ignored in this example.' },
      },
    },
    accepts: {
      scheme: 'exact',
      price: { asset: XLM_SAC, amount: PRICE_STROOPS },
      network: NETWORK,
      payTo: merchantAddress,
    },
  },
});

const app = express();
app.use(paymentMiddlewareFromHTTPServer(httpServer));

app.get('/api/joke', (req, res) => {
  res.json({ joke: 'Why do programmers prefer dark mode? Because light attracts bugs.' });
});

app.listen(3401, () => console.log('Paid API running at http://localhost:3401/api/joke'));
```

Key points:

- **`price.amount` is in stroops**, not XLM. `2500` stroops = `0.00025` XLM. Getting the
  decimal place wrong either prices your endpoint at 1/10,000,000th of what you meant
  or scares every buyer off. The SDK helper below converts for you.
- **`payTo` must be your account** — the one that holds (or will hold) the asset.
- **`extensions: ['bazaar']`** opts the route into automatic cataloguing. Without it,
  the payment still works but the resource is not listed for discovery.

The middleware intercepts the request, and if no valid payment accompanies it, answers
`402 Payment Required` with the terms from `accepts` — the buyer reads those terms,
signs an authorization, and retries with the signature, at which point the request
reaches your handler.

### Verify it answers 402 before you go further

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3401/api/joke   # expect 402
curl -s http://localhost:3401/api/joke | head -c 400                       # the terms JSON
```

A `402` here means the whole payment flow is wired: the resource server is speaking
x402, and the facilitator URL it points at is reachable.

---

## 4. Declare discovery metadata (the Bazaar extension)

Cataloguing is what turns a paid endpoint into a **discoverable** one. The facilitator
reads the `bazaar` extension on the payment payload and, on a successful verify or
settle, asynchronously upserts the listing — never on the payment's critical path, and
never able to fail the payment.

The route declaration above is the primary path. You can also build the declaration
with this repo's SDK helper, which validates and converts human amounts to stroops:

```js
import { createStellarDiscoveryResource } from 'x402-facilitator-stellar/sdk';

const declaration = createStellarDiscoveryResource({
  routeTemplate: '/api/joke',
  title: 'Dad Joke Generator',
  description: 'Generates a random dad joke.',
  parameters: { category: { type: 'string', description: 'Optional category.' } },
  pricing: { amount: '0.00025', asset: XLM_SAC }, // 0.00025 XLM — stroops conversion handled
  network: 'stellar:testnet',
  scheme: 'exact',
});
```

Amounts are given as **decimal strings** (e.g. `'2.5'`), never JavaScript numbers — a number has usually lost precision before conversion and is rejected. Stellar amounts are 7-decimal fixed point (stroops): a fractional part longer than 7 decimals is **truncated** (the 8th digit and beyond are dropped), never rounded, because rounding would invent stroops that never existed. A non-numeric amount fails validation with a structured message, not a low-level parse error.


Validate a declaration offline, without paying anyone, with the bundled CLI:

```bash
npx validate-discovery metadata.json
```

The same validation runs server-side before anything is catalogued; what is rejected
there is described in the next section.

### Confirm the listing landed

Two ways to confirm, in increasing order of ceremony:

**1. Search the catalog** (this is what agents do):

```bash
curl -s "http://localhost:3402/discovery/search?query=joke" | jq '.resources[0] | {url, serviceName, pricing}'
```

**2. Read the `EXTENSION-RESPONSES` header on a successful payment.** Every
`/verify` and `/settle` response that carried a discovery extension reports the
cataloguing outcome in a base64-encoded header, so a seller can confirm the listing
without a separate round trip:

```bash
curl -s -D - -o /dev/null -X POST http://localhost:3402/verify \
  -H "content-type: application/json" \
  -d '{"paymentPayload":{...},"paymentRequirements":{...}}' \
  | grep -i EXTENSION-RESPONSES
# decode:
echo "<header value>" | base64 -d
# -> {"bazaar":{"status":"landed","code":"catalog_success"}}
```

Possible outcomes, and what they mean for you:

| `status` | `code` | Meaning |
| --- | --- | --- |
| `landed` | `catalog_success` | Listed. Agents can now find the resource. |
| `partially landed` | `catalog_partial` | Listed, but optional fields were dropped (see the soft-drop table below). |
| `rejected` | e.g. `invalid_routeTemplate`, `catalog_rate_limited` | Not listed. See the next section. |
| `not attempted` | — | The payload carried no usable discovery extension, so nothing was catalogued. |

Manual registration also exists for cases where you want a listing without a payment
driving it: `POST /discovery/resources` with the same payment-shaped body, authenticated
with an API key (see [`docs/AUTHENTICATION.md`](./AUTHENTICATION.md)).

---

## 5. When cataloguing is rejected

The catalog validates every submitted resource. Failures come in three severities,
each with a different action:

### Hard drop — the resource is discarded

| Reason | Cause | Fix |
| --- | --- | --- |
| `invalid_routeTemplate` | `routeTemplate` is unparseable, uses double-encoded traversal, or fails the security boundary (SSRF / path traversal protection) | Use a clean route template like `/api/joke` or `/api/resource/{id}` |
| `missing_or_invalid_discovery_extension` | The `bazaar` extension was absent or malformed on the payload | Declare `extensions: ['bazaar']` and a valid resource body |
| `invalid_resource` | The resource body failed structural validation | Check the error body's `reason` field for the exact validator complaint |

### Soft drop — the resource lands, the field does not

| Field | What happens | Why |
| --- | --- | --- |
| `routeTemplate` (bare wildcard `*`) | Field removed, resource still listed | Upstream's own SDK registers wildcards by default; a seller on stock defaults should not vanish from discovery. Use a concrete template to keep it. |
| `serviceName` | Field removed | Invalid or oversized. |
| `iconUrl` | Field removed | Invalid URL or a private-IP address (SSRF protection). |
| `description` | Truncated to 200 chars | HTML stripped and length capped. |
| `tags` | Invalid tags dropped | Tag flooding protection. |

A soft drop reports `status: "partially landed"` with the dropped fields named in the
`reason`. The listing is live; you can fix the fields on the next payment.

### Rate limited

Cataloguing shares a per-IP bucket (`catalog_rpm`, default 10/min; there is also a cap
of 50 resources per `payTo` address). Exceeding it returns
`catalog_rate_limited`, which is **retryable** — wait for `Retry-After` and retry.

---

## 6. Getting paid, end to end

With the facilitator running, the endpoint declared, and the first payment through, the
whole loop is:

1. Agent requests `GET /api/joke` → **402** with terms (`asset`, `amount`, `payTo`).
2. Agent signs a Soroban authorization transferring `amount` to `payTo`, wrapped in the
   x402 `payload: {transaction}` shape.
3. Agent retries with the payment signature; your server calls the facilitator's
   `/verify`, then `/settle`.
4. Facilitator verifies the authorization on-chain, submits the settlement (sponsoring
   the fee), and returns the transaction hash.
5. Your handler runs; the buyer got the resource, your account got the payment.

Watch it happen on the seller side:

```bash
# in the example's terminal
[x402] Payment successful: <tx-hash> from <payer-address>
```

Inspect the settlement on a testnet explorer:

```
https://stellar.expert/explorer/testnet/tx/<tx-hash>
```

---

## 7. Going further

- **SDK validation** — `npx validate-discovery metadata.json` checks a declaration
  before it is ever submitted; the server runs the same checks again.
- **MCP tooling** — agents find you through the catalog the same way the MCP server
  does; see [`docs/MCP.md`](./MCP.md) and the buyer guide
  ([`docs/BUYER.md`](./BUYER.md)).
- **Mainnet** — same code, different `network` (`stellar:pubnet`), a real account with
  a trustline, real USDC (`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`),
  and a facilitator configured for pubnet — see
  [`docs/OPERATOR.md`](./OPERATOR.md) for the operational differences (key separation,
  RPC provider, fee ceilings).

## Reference

- [`examples/http-seller`](../examples/http-seller) — the worked example this guide
  walks through.
- [`docs/BAZAAR.md`](./BAZAAR.md) — catalog data model, filters, validation policy.
- [`docs/REASONS.md`](./REASONS.md) — every rejection code the service can emit.
- [`docs/AUTHENTICATION.md`](./AUTHENTICATION.md) — what is authenticated, what is open.
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — running your own facilitator.
