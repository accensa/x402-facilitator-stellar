# Pubnet Fee Calibration & Floor Derivation

> **Context:** Calibrates `MAX_TX_FEE_STROOPS_PUBNET` from live Stellar mainnet fee statistics pulled via Horizon `/fee_stats`, derives the enforced floor (`min`) and default ceiling (`defaultValue`), and documents the daily settlement budget relationship (`feeSpd` / ceiling). Addresses issue #650 and tracking issue #653 (production hardening for pubnet).

---

## 1. Background & Operating Model

On Stellar mainnet (`stellar:pubnet`), the facilitator sponsors transaction fees on behalf of callers. As outlined in `docs/DEPLOYMENT.md`, the per-transaction fee ceiling is the boundary that limits the loss any single compromised signer key can cause.

The facilitator enforces two levels of protection:
1. **Per-transaction ceiling (`MAX_TX_FEE_STROOPS_PUBNET`):** The maximum fee in stroops (1 XLM = 10,000,000 stroops) that the facilitator will bid or sponsor for an individual settlement transaction.
2. **Daily fee budget (`feeSpd`):** Configured via rate limits (default `5,000,000` stroops, or 0.5 XLM/day).

Previously, `MAX_TX_FEE_STROOPS_PUBNET` had an unmeasured default of `50,000` stroops and an uncalibrated floor of `100` stroops. Setting a ceiling of 100 stroops risks immediate settlement starvation under standard network activity where inclusion rates exceed the protocol base fee.

---

## 2. Live Mainnet Measurement

Measurements were taken on **November 19, 2026** using the read-only script `scripts/calibrate-pubnet-fee.mjs` against the public Horizon mainnet endpoint (`https://horizon.stellar.org/fee_stats`).

### Measurement Window & Sample
- **Horizon URL:** `https://horizon.stellar.org/fee_stats`
- **Measurement Window:** Rolling window of 200 ledgers (Ledgers 65559698 – 65559897)
- **Sample Count:** 200 ledgers (~16.7 minutes of mainnet blocks at ~5s ledger close time)
- **Protocol Base Fee:** 100 stroops
- **Ledger Capacity Usage:** 65.0% – 73.0%

### Fee Charged Percentiles (Stroops per Operation)

| Metric | Measured Value (stroops) | Equivalent (XLM) |
|---|---|---|
| **min** | 100 | 0.0000100 XLM |
| **mode** | 100 | 0.0000100 XLM |
| **p50 (median)** | 100 | 0.0000100 XLM |
| **p90** | 5,056 | 0.0005056 XLM |
| **p95** | 18,888 | 0.0018888 XLM |
| **p99** | 32,830 – 172,922 | 0.0032830 – 0.0172922 XLM |
| **max** | 250,243 | 0.0250243 XLM |

---

## 3. Canonical Settlement Simulation

In this facilitator service, a canonical payment settlement constitutes **one operation** (a token payment/transfer or Soroban `invokeHostFunction` invocation).

Total transaction fee for 1 operation:
$$\text{Total Fee} = \text{Operation Count} \times \text{Fee Rate}$$

- **At Base Fee:** 100 stroops (0.00001 XLM)
- **At Median (p50):** 100 stroops (0.00001 XLM)
- **At P90 (Congestion):** 5,056 stroops (0.0005056 XLM)
- **At P99 (Surge):** 32,830 stroops (0.0032830 XLM)

---

## 4. Derivation of Ceiling and Floor

### Enforced Floor (`min: 5_056`)
- **Derivation:** Anchored directly at the measured **p90** fee charged rate (`5,056` stroops) with **0% headroom**.
- **Rationale:** If an operator configures a ceiling below p90, settlements will consistently fail or stall during standard congestion peaks. Enforcing `min: 5_056` in `src/config.js` guarantees that every valid configuration can clear at least 90% of mainnet ledgers.

### Default Ceiling (`defaultValue: 50_000`)
- **Derivation:** Calibrated at `50,000` stroops (0.005 XLM).
- **Headroom Applied:** **~9.89x headroom** over p90 (`5,056` stroops), and **~1.52x headroom** over measured p99 (`32,830` stroops).
- **Rationale:** Allows normal settlement traffic to succeed with ample safety margin during sudden demand spikes, while strictly capping the liability of an individual compromised key to 0.005 XLM per transaction.

---

## 5. Daily Budget & Operator Settlement Capacity

Operators evaluate their fee posture as a **daily budget**, defined by `feeSpd` (5,000,000 stroops = 0.5 XLM/day):

$$\text{Daily Capacity} = \left\lfloor \frac{\text{feeSpd}}{\text{Ceiling}} \right\rfloor$$

| Configuration | Fee Ceiling (stroops) | Daily Settlement Capacity (`feeSpd = 5M`) |
|---|---|---|
| **Calibrated Default Ceiling** | 50,000 | **100** settlements / day (worst-case scenario) |
| **P90 Congested Settlement** | 5,056 | **988** settlements / day |
| **P50 / Base Fee Settlement** | 100 | **50,000** settlements / day |

This derivation guarantees that:
- In the worst case where every transaction consumes the entire ceiling (50,000 stroops), the service admits exactly 100 sponsored settlements per day before triggering `fee_ceiling_exceeded`.
- Under normal operational conditions (fees near p90 or lower), the service admits between 988 and 50,000 settlements daily.

---

## 6. Tooling & Test Verification

- **Measurement Script:** `scripts/calibrate-pubnet-fee.mjs` (run via `npm run pubnet:fee-stats`) queries public Horizon endpoints without requiring secrets or submitting transactions.
- **Offline Guard Test:** `test/pubnet-fee-floor.test.js` tests config resolution offline, verifying rejection of ceilings below `5,056` and acceptance of the derived default `50,000`.
