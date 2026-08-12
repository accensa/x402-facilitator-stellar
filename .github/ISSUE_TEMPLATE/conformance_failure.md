---
name: Conformance failure
about: A canonical x402 client did something this facilitator did not handle correctly
title: 'conformance: '
labels: 'area: facilitator'
---

<!--
This is the most useful issue you can file here. The whole point of the service
is that stock SDK code works against it unmodified, so a case where it does not
is worth more than a feature request.
-->

## What you pointed at it

| | |
|---|---|
| Client | <!-- e.g. @x402/core 2.21.0 --> |
| Scheme / network | <!-- e.g. exact / stellar:testnet --> |
| Facilitator URL or commit | |

## What you expected

<!-- Quote the spec or the package if you can. -->

## What happened

<!-- The actual request and response. Redact secrets, but do not paraphrase the
     wire format — the exact field names are usually the whole issue. -->

```http
```

## Reproducing it

<!-- Ideally the smallest stock-SDK snippet that shows it. -->

```js
```

## Anything else

<!-- Settled transaction hash, ledger, timing — whatever you have. -->
