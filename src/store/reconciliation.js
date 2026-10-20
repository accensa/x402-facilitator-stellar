import { TESTNET } from '../config.js';

const DEFAULT_TESTNET_RPC = 'https://soroban-testnet.stellar.org';

/**
 * Default JSON-RPC call helper for reconciliation.
 *
 * Bounded by AbortSignal.timeout under the house convention (see
 * facilitator.js, embeddings, readiness): a hung RPC errors into the sweep's
 * existing per-record warning instead of stalling unknown-settlement
 * resolution. Configurable via RECONCILIATION_RPC_TIMEOUT_MS (default 5s).
 */
async function defaultRpcCall(rpcUrl, body, timeoutMs = reconciliationRpcTimeoutMs()) {
  let res;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`reconciliation rpc timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  return await res.json();
}

function reconciliationRpcTimeoutMs() {
  const raw = Number(process.env.RECONCILIATION_RPC_TIMEOUT_MS ?? 5_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

/**
 * Polls the network RPC to resolve settlements recorded in 'unknown' state (#10).
 *
 * @param {object} store - settlement store instance
 * @param {object} [config] - resolved config
 * @param {object} [options]
 * @param {Function} [options.rpcCall] - injected rpc call function (tests)
 */
export async function reconcileUnknownSettlements(store, config = {}, { rpcCall } = {}) {
  const call = rpcCall ?? defaultRpcCall;
  const unknownRecords = await store.listUnknown();
  if (!Array.isArray(unknownRecords) || unknownRecords.length === 0) {
    return { reconciled: 0 };
  }

  let count = 0;
  for (const record of unknownRecords) {
    if (!record.tx_hash) continue;

    const netConfig = config?.perNetwork?.[record.network] ?? {};
    const rpcUrl = netConfig.rpcUrl ?? (record.network === TESTNET ? DEFAULT_TESTNET_RPC : null);
    if (!rpcUrl) continue;

    try {
      const res = await call(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: { hash: record.tx_hash },
      });

      const status = res?.result?.status;
      if (status === 'SUCCESS') {
        // This settlement was settled on-chain without a completed /settle
        // response, so no notification was ever emitted — enqueue one through
        // the same transactional outbox as the primary settle path (#123).
        // Without an outbox (in-memory store) this is a no-op, matching the
        // pre-outbox behaviour where reconciliation never notified.
        await store.settleAndEnqueue(
          record.idempotency_key,
          { tx_hash: record.tx_hash, error_reason: null, error_message: null },
          {
            type: 'settlement.completed',
            transaction: record.tx_hash,
            network: record.network,
            payer: record.payer,
            payTo: record.pay_to,
            amount: record.amount,
            asset: record.asset,
          },
        );
        count++;
      } else if (status === 'FAILED') {
        await store.updateState(record.idempotency_key, 'failed', {
          tx_hash: record.tx_hash,
          error_reason: 'transaction_failed',
          error_message: 'Transaction failed on chain',
        });
        count++;
      }
    } catch (err) {
      console.warn(`[Reconciliation] Failed to poll tx ${record.tx_hash}: ${err.message}`);
    }
  }

  return { reconciled: count };
}

/**
 * Starts periodic background reconciliation loop.
 */
export function startReconciliationLoop(store, config, { intervalMs = 30_000, rpcCall } = {}) {
  const timer = globalThis.setInterval(() => {
    reconcileUnknownSettlements(store, config, { rpcCall }).catch(err => {
      console.warn(`[Reconciliation] Loop error: ${err.message}`);
    });
  }, intervalMs);

  return {
    stop: () => globalThis.clearInterval(timer),
  };
}

export { defaultRpcCall };
