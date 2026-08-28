# X402 Facilitator Documentation Hub

Welcome to the X402 Facilitator documentation. Choose the path that best matches your role:

- [Seller Guide](./SELLER.md): "I have an API and I want to charge agents for it" — from zero
  to a paid, catalogued endpoint on testnet: account setup, trustlines, the x402 endpoint,
  the Bazaar listing, and what to do when cataloguing is rejected.
- [Buyer / Agent Guide](./BUYER.md): "I want my agent to find and pay for services" — the
  discover-pay-retry loop with a copy-pasteable script, every rejection code the service
  can emit, and the MCP route for agent runtimes.
- [Operator Guide](./OPERATOR.md): "I want to run my own facilitator" — hosted vs
  self-hosted, every environment variable, key management, rate limiting and metering,
  monitoring, and the operational runbook.

**Reference:**
- [Architecture](./ARCHITECTURE.md): System design, components, and the discovery path
- [Business Model](./BUSINESS-MODEL.md): who pays for what, metering, and why the rate limits sit where they do
- [Event Sourcing](./EVENT-SOURCING.md): The append-only settlement state machine and its audit trail
- [Glossary](./GLOSSARY.md): Terminology (Stellar, X402, and Facilitator concepts)
- [Deployment](./DEPLOYMENT.md): Containers, topology, environment variables, shared stores
- [Operations](./OPERATIONS.md): Rate limiting, metering, multi-signer pools, health endpoints
- [Authentication](./AUTHENTICATION.md): What is authenticated, what is open, and why
- [Bazaar](./BAZAAR.md): The discovery catalog — data model, endpoints, validation policy
- [MCP](./MCP.md): The standalone MCP server for agent runtimes
- [Reasons](./REASONS.md): The exhaustive rejection-reason taxonomy
- [Conformance](./CONFORMANCE.md): Wire-level conformance evidence and the maintenance commitment
- [Onboarding Timing](./ONBOARDING_TIMING.md): The measurement instrument for the RFP's
  "under an hour to a paid, discoverable endpoint" claim (#155)

## Contributing these guides to Stellar Developer Docs

The SCF RFP names a role-based developer guide "contributed to Stellar Developer Docs"
as a deliverable. These three guides are the in-repo source of that contribution.

- **Where:** Stellar Developer Docs are maintained in the
  [`stellar/stellar-docs`](https://github.com/stellar/stellar-docs) repository; the
  x402 section lives under
  `developers.stellar.org/docs/build/agentic-payments/x402`.
- **How:** contributions are PRs to that repository. Follow
  [`stellar-docs/CONTRIBUTING.md`](https://github.com/stellar/stellar-docs/blob/main/CONTRIBUTING.md)
  for their conventions; the existing
  [x402 page](https://developers.stellar.org/docs/build/agentic-payments/x402) is the
  landing point a seller/buyer/operator set of guides would attach to.
- **Upstream constraints:** the docs site is community-governed, so content must be
  protocol-generic where possible (the facilitator is one implementation among several),
  must not advertise this repository as the only option, and must be validated against
  testnet before submission — the same standard these in-repo guides hold.
- **Status:** the contribution is planned as a follow-up PR against `stellar/stellar-docs`
  once the in-repo guides have been exercised by a second reader; tracked with the
  rest of the wave deliverables. The in-repo guides are the living source of truth in
  the meantime.
