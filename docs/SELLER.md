# Seller Guide: from zero to a paid, discoverable endpoint on Stellar testnet

1. **Add X402 to an existing Express API:** Add the `@x402/core` middleware to intercept requests.
2. **Choose an asset and price:** Setup a trustline for USDC receipt — see [Trustlines](#trustlines) below. (See our demo-merchant example).
3. **Declare discovery metadata:** Provide metadata on your endpoints using our Stellar-shaped SDK helpers:
   
   *Before:*
   ```javascript
   // Manual declaration without helpers (error-prone stroop conversion)
   app.get('/api/resource', x402({
       pricing: { amount: '25000000', asset: 'XLM' },
       network: 'stellar:testnet',
       scheme: 'exact'
   }), (req, res) => { /* ... */ });
   ```
   
   *After:*
   ```javascript
   // With discovery helpers
   import { createStellarDiscoveryResource } from 'x402-facilitator-stellar/sdk';
   
   app.get('/api/resource/{id}', x402(createStellarDiscoveryResource({
       routeTemplate: '/api/resource/{id}',
       parameters: { id: 'The resource ID' },
       pricing: { amount: '2.5', asset: 'XLM' }
   })), (req, res) => { /* ... */ });
   ```
   
   You can also validate your metadata offline without making payments:
   ```bash
   npx validate-discovery metadata.json
   ```
4. **Verify listing:** Check the Bazaar endpoint to ensure you are listed. Your
   payment responses also tell you directly: every successful `/verify` and
   `/settle` response carries an `EXTENSION-RESPONSES` header describing what
   the Bazaar did with your resource (landed, partially landed, rejected, or
   not attempted) — see [docs/BAZAAR.md#the-extension-responses-header](BAZAAR.md#the-extension-responses-header)
   for the encoding, all four outcomes, and what to do about each rejection
   code.
5. **Troubleshooting:**
   - *Error: Trustline missing.* See [Trustlines](#trustlines).
   - *Error: Invalid signature.* Ensure the agent signs with the correct private key.

## Trustlines

On Stellar an account can only hold — and therefore only receive — an issued asset (USDC, any SEP-41 token) once it has authorized the issuer with a **trustline** (`changeTrust`). Native XLM needs no trustline.

- **USDC:** to receive USDC, your payee account needs a USDC trustline — a `changeTrust` for the USDC issuer. On testnet, `npm run testnet:fund` funds a fresh account and opens the USDC trustline on it in one step.
- **Pricing in a different asset:** add a trustline for that asset the same way (a `changeTrust` for that issuer).
- **Mainnet:** the same `changeTrust` operation, with the mainnet network passphrase and the issuer of the asset you price in. Friendbot does not exist on pubnet.

**Error: Trustline missing.** Ensure you have an active trustline for the asset. A missing trustline on either side of the transfer is the most common first-payment failure on Stellar: the transaction dies in simulation and reads as a generic failure, so check the listing's `asset` and confirm both accounts trust it.
