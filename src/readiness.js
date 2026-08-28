/**
 * Readiness checking (issue #100).
 *
 * GET /healthz answers "is the process up?" and must never consult a
 * dependency — a liveness probe that fails on a downstream outage causes
 * restart loops that make the outage worse. This module is the other half:
 * "can this instance actually settle right now?", reported per network so an
 * orchestrator can stop routing traffic into a broken replica.
 *
 * Per configured network it checks, independently:
 *   - Soroban RPC reachable (JSON-RPC getHealth)
 *   - the facilitator signer account exists and holds at least the funding
 *     floor — an unfunded signer means no settlement can be sponsored
 *
 * BOUNDING THE CHECK. installRpcRetry retries connection failures five times
 * with linear backoff (~12s against a dead endpoint). A readiness probe that
 * inherits that budget hangs the orchestrator's probe window instead of
 * failing fast, so every RPC here runs under its own AbortController timeout
 * (READINESS_TIMEOUT_MS, default 3s) rather than the retry budget. The abort
 * code is not in RETRYABLE, so the wrapper does not retry past it.
 *
 * CACHING. Probes run every 30s per replica; an uncached check would turn each
 * one into a burst of RPC calls across all replicas. Results are cached for
 * READINESS_CACHE_TTL_MS (default 5s).
 *
 * CATALOG RULE. Catalogue-store trouble is reported in the response but never
 * fails readiness: processCataloging establishes that a cataloguing failure
 * must never fail a payment, and readiness exists to predict payment
 * capability. Same logic, applied to the same rule.
 */
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { TESTNET } from './config.js';

const DEFAULT_TESTNET_RPC = 'https://soroban-testnet.stellar.org';

/**
 * Builds a readiness checker over the resolved config.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @param {object} [overrides] - test seams
 * @param {Function} [overrides.rpcCall] - async (rpcUrl, body) => parsed JSON;
 *   injected by tests to simulate an unreachable or misbehaving RPC
 * @param {number} [overrides.timeoutMs]
 * @param {number} [overrides.cacheTtlMs]
 * @param {number} [overrides.minBalanceStroops]
 */
export function createReadinessChecker(
  config,
  {
    rpcCall,
    timeoutMs = Number(process.env.READINESS_TIMEOUT_MS ?? 3_000),
    cacheTtlMs = Number(process.env.READINESS_CACHE_TTL_MS ?? 5_000),
    minBalanceStroops = Number(process.env.READINESS_FUNDING_FLOOR_STROOPS ?? 0),
    breakerStates = () => null,
    catalog = null,
  } = {},
) {
  const call = rpcCall ?? ((url, body) => defaultRpcCall(url, body, timeoutMs));
  const targets = config.networks.map(network => {
    const netConfig = config.perNetwork[network];
    const secrets = netConfig.secrets ?? (netConfig.secret ? [netConfig.secret] : []);
    const addresses = secrets.map(sec => Keypair.fromSecret(sec).publicKey());
    const feeBumpAddress = netConfig.feeBumpSecret
      ? Keypair.fromSecret(netConfig.feeBumpSecret).publicKey()
      : null;
    return {
      network,
      rpcUrl: netConfig.rpcUrl ?? (network === TESTNET ? DEFAULT_TESTNET_RPC : undefined),
      addresses,
      feeBumpAddress,
    };
  });

  let cache = null;
  let isShuttingDown = false;

  async function checkRpc(target) {
    const res = await call(target.rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getHealth',
    });
    const status = res?.result?.status;
    return status === 'healthy'
      ? { ok: true }
      : { ok: false, error: `rpc health '${status}' is not 'healthy'` };
  }

  async function checkSignerAddress(rpcUrl, address) {
    try {
      const accountId = Keypair.fromPublicKey(address).xdrAccountId();
      const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
      const res = await call(rpcUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'getLedgerEntries',
        params: { keys: [key.toXDR('base64')] },
      });
      const entries = res?.result?.entries ?? [];
      if (entries.length === 0) {
        return { ok: false, address, error: `signer account ${address} does not exist (unfunded)` };
      }
      // Soroban RPC's getLedgerEntries returns each entry's ledger data under
      // the `xdr` field (key/xdr/lastModifiedLedgerSeq/extXdr), not `val`.
      const entryData = xdr.LedgerEntryData.fromXDR(entries[0].xdr, 'base64');
      const balance = Number(entryData.account().balance());
      if (balance < minBalanceStroops) {
        return {
          ok: false,
          address,
          balance_stroops: balance,
          error: `signer ${address} balance ${balance} is below floor ${minBalanceStroops}`,
        };
      }
      return { ok: true, address, balance_stroops: balance };
    } catch (err) {
      return { ok: false, address, error: err.message };
    }
  }

  async function checkSigners(target) {
    const results = [];
    for (const addr of target.addresses) {
      results.push(await checkSignerAddress(target.rpcUrl, addr));
    }
    if (target.feeBumpAddress) {
      results.push(await checkSignerAddress(target.rpcUrl, target.feeBumpAddress));
    }

    const allOk = results.every(r => r.ok);
    const firstBalance = results[0]?.balance_stroops;
    if (!allOk) {
      const failing = results.filter(r => !r.ok);
      return {
        ok: false,
        balance_stroops: firstBalance,
        error: failing.map(f => f.error).join('; '),
        signers: results,
      };
    }
    return { ok: true, balance_stroops: firstBalance, signers: results };
  }

  async function checkNetwork(target) {
    let rpc;
    try {
      rpc = await checkRpc(target);
    } catch (err) {
      rpc = { ok: false, error: err.message };
    }
    let signer;
    try {
      signer = await checkSigners(target);
    } catch (err) {
      signer = { ok: false, error: err.message };
    }
    const ready = rpc.ok && signer.ok;
    return {
      network: target.network,
      rpc_url: target.rpcUrl ?? '(package default)',
      ready,
      checks: { rpc_reachable: rpc, signer_funded: signer },
    };
  }

  async function check() {
    if (isShuttingDown) {
      return {
        ok: false,
        status: 'shutting_down',
        checked_at: new Date().toISOString(),
        reason: 'shutdown_in_progress',
      };
    }
    const fresh = cache && Date.now() - cache.checked_at_ms < cacheTtlMs;
    if (fresh) return cache.snapshot;

    const networks = {};
    for (const target of targets) {
      networks[target.network] = await checkNetwork(target);
    }
    const ready = Object.values(networks).every(n => n.ready);

    // Reported, never fatal: see CATALOG RULE above.
    let catalogState = null;
    if (catalog) {
      catalogState = { backend: catalog.constructor.name, ok: true };
      try {
        if (typeof catalog.healthCheck === 'function') {
          const health = await catalog.healthCheck();
          catalogState.ok = health?.ok !== false;
        }
      } catch (err) {
        catalogState.ok = false;
        catalogState.error = err.message;
      }
    }

    const snapshot = {
      ok: ready,
      status: ready ? 'ready' : 'not_ready',
      checked_at: new Date().toISOString(),
      networks,
      breakers: breakerStates(),
      ...(catalogState ? { catalog: catalogState } : {}),
    };
    cache = { checked_at_ms: Date.now(), snapshot };
    return snapshot;
  }

  /** Test/ops seam: drop the cache so the next check dials for real. */
  function invalidate() {
    cache = null;
  }

  function setShuttingDown() {
    isShuttingDown = true;
    cache = null;
  }

  return { check, invalidate, setShuttingDown };
}

/**
 * One JSON-RPC POST under its own hard timeout. Uses globalThis.fetch (the
 * retry-wrapped one), but the abort fires inside the retry window's first
 * attempt and ABORT_ERR is not retryable, so the budget cannot stretch this.
 */
async function defaultRpcCall(rpcUrl, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
