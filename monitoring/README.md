# External monitoring

Probes the facilitator from **outside our own infrastructure** so a silent outage
cannot also silence its own monitor. Driven by [`probes.mjs`](probes.mjs) and the
[`external-monitor`](../../.github/workflows/external-monitor.yml) GitHub Actions
cron workflow (runs from GitHub's runners every 15 min).

## Configure

Copy [`config.example.json`](config.example.json) to `monitoring/config.json`
(or set `MONITORING_CONFIG` to a path/secret) and fill in:

- `endpoint` — public facilitator URL (overridable with `FACILITATOR_URL`).
- `probe.signerBalance.signers[]` — facilitator signer **addresses** per network
  with `warnFloorStroops` and `signalFloorStroops` (alert before the pool runs dry).
- `probe.syntheticPayment` — set `enabled: true` (or `SYNTHETIC_PAYMENT=true` in
  the workflow) to run a real `/verify`+`/settle` on testnet. Needs
  `FACILITATOR_SECRET` and `ALICE_SECRET` (see `scripts/e2e.mjs`).

## Run locally

```bash
FACILITATOR_URL=https://facilitator.example.com node monitoring/probes.mjs
```

Writes `monitoring/out/status.json` and exits non-zero if any probe that is
"down = incident" fails. The
[status page](../status/) consumes `status.json`.

## Alerting

On failure the workflow posts to `ALERT_WEBHOOK_URL` and fails the job, paging the
**Facilitator On-Call** (escalation path in [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md)).
