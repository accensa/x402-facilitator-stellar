# External monitoring

Probes the facilitator from **outside our own infrastructure** so a silent outage
cannot also silence its own monitor. Driven by [`probes.mjs`](probes.mjs) and the
[`external-monitor`](../.github/workflows/external-monitor.yml) GitHub Actions
cron workflow (runs from GitHub's runners every 15 min).

## Configure

Copy [`config.example.json`](config.example.json) to `monitoring/config.json`
(or set `MONITORING_CONFIG` to a path/secret) and fill in:

- `endpoint` — public facilitator URL (overridable with `FACILITATOR_URL`).
- `probe.signerBalance.signers[]` — facilitator signer **addresses** per network
  with `warnFloorStroops` and `signalFloorStroops` (alert before the pool runs dry).
- `probe.syntheticPayment` — set `enabled: true` (or `SYNTHETIC_PAYMENT=true` in
  the workflow) to run a real `/verify`+`/settle` on testnet through
  `scripts/e2e.mjs`. That one documented command is spawned with an explicit
  environment — `ALICE_SECRET` (the payer key), `FACILITATOR_URL`,
  `MERCHANT_ADDRESS` and `RESOURCE_PORT` — and nothing else from the monitor's
  environment; a config-supplied `command` override receives no credential at
  all. `FACILITATOR_SECRET` is not needed here: it belongs to the facilitator
  under test, not to the probe.

## Run locally

```bash
FACILITATOR_URL=https://facilitator.example.com node monitoring/probes.mjs
```

Writes `monitoring/out/status.json` and exits non-zero if any probe that is
"down = incident" fails. The
[status page](../status/) consumes `status.json`.

## Alerting

On failure the workflow posts to `ALERT_WEBHOOK_URL` and fails the job, paging the
**Facilitator On-Call** (escalation path in [`docs/OPERATIONS.md`](../docs/OPERATIONS.md)).
