/**
 * Asset decimals cache for SEP-0041 compliance (#415).
 *
 * Queries asset contract decimals via Soroban RPC and caches metadata.
 * Prevents floating-point rounding inaccuracies by using BigInt arithmetic
 * exclusively. Rejects transactions specifying fractional subunits below
 * minimum asset decimal granularity.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Creates an asset decimals cache.
 *
 * @param {object} [options]
 * @param {Function} [options.rpcCall] - async (rpcUrl, body) => parsed JSON; injected by tests
 * @param {string} [options.rpcUrl] - Soroban RPC URL for fetching decimals
 * @param {number} [options.ttlMs] - cache TTL in milliseconds
 * @param {Map<string, number>} [options.preloaded] - preloaded asset decimals (e.g. native XLM = 7)
 */
export function createAssetDecimalsCache({
  rpcCall = globalThis.fetch?.bind(globalThis),
  rpcUrl = 'https://soroban-testnet.stellar.org',
  ttlMs = DEFAULT_TTL_MS,
  preloaded = new Map([
    ['native', 7],
    ['XLM', 7],
    ['xlm', 7],
  ]),
} = {}) {
  const cache = new Map(); // assetId -> { decimals, expiresAt }
  const pending = new Map(); // assetId -> Promise<number>

  // Seed with preloaded values
  for (const [asset, decimals] of preloaded) {
    cache.set(normalizeAssetId(asset), { decimals, expiresAt: Infinity });
  }

  function normalizeAssetId(asset) {
    // Native XLM is represented as 'native' in Stellar
    if (asset === 'native' || asset === 'XLM' || asset === 'xlm') return 'native';
    // Contract IDs are case-sensitive, keep as-is
    return asset;
  }

  /**
   * Fetches decimals for a Stellar asset contract via Soroban RPC.
   * Uses the `getContractMetadata` or simulates the `decimals()` call.
   */
  async function fetchDecimals(assetId) {
    const normalized = normalizeAssetId(assetId);
    if (normalized === 'native') return 7;

    // Check if it's a contract ID (starts with C)
    if (!normalized.startsWith('C') || normalized.length !== 56) {
      throw new Error(`Invalid asset contract ID: "${assetId}"`);
    }

    // Simulate the decimals() call via Soroban RPC
    // This uses the standard ERC20/SEP-41 decimals() interface
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: {
        transaction: await buildDecimalsSimulationTx(normalized),
      },
    };

    if (!rpcCall) throw new Error('No RPC call implementation available');

    const res = await rpcCall(rpcUrl, body);
    const result = res?.result?.results?.[0]?.xdr;
    if (!result) {
      throw new Error(`Failed to fetch decimals for asset ${assetId}: ${JSON.stringify(res)}`);
    }

    // Parse the simulation result to extract the decimals value
    // The result is a VecU16 with one element (the decimals u8)
    const { xdr } = await import('@stellar/stellar-sdk');
    const vec = xdr.ScVal.fromXDR(result, 'base64');
    if (vec.switch() !== xdr.ScValType.scvVec()) {
      throw new Error(`Unexpected decimals result type: ${vec.switch().name}`);
    }
    const decimalsVal = vec.vec()?.[0];
    if (!decimalsVal || decimalsVal.switch() !== xdr.ScValType.scvU16()) {
      throw new Error(`Unexpected decimals value type: ${decimalsVal?.switch()?.name}`);
    }
    return decimalsVal.u16();
  }

  async function buildDecimalsSimulationTx(contractId) {
    // Build a minimal transaction that calls decimals() on the contract
    // This is a simplified version - in production you'd use the stellar-sdk
    // to properly construct the simulation transaction
    const { xdr, Keypair } = await import('@stellar/stellar-sdk');
    const source = Keypair.random().publicKey(); // dummy source for simulation
    const contractIdScVal = xdr.ScVal.scvBytes(Buffer.from(contractId, 'base64'));

    const invokeHostFn = xdr.InvokeHostFn.invokeContract({
      contractAddress: xdr.ScAddress.scAddressContract(contractIdScVal),
      funcName: 'decimals',
      args: [],
    });

    const tx = new xdr.Transaction({
      sourceAccount: xdr.MuxedAccount.muxedEd25519(
        xdr.Uint256.fromString(source.slice(1)), // simplified
        new xdr.Uint64(0),
      ),
      fee: new xdr.Uint64(100),
      seqNum: xdr.SequenceNumber.fromString('0'),
      cond: xdr.Preconditions.precondTime({ minSeqNum: 0, minSeqAge: 0, minSeqLedgerGap: 0 }),
      memo: xdr.Memo.memoNone(),
      operations: [
        new xdr.Operation({
          body: xdr.OperationBody.invokeHostFunction(invokeHostFn),
          sourceAccount: null,
        }),
      ],
      ext: new xdr.TransactionExt(0),
    });

    return tx.toEnvelope().toXDR('base64');
  }

  /**
   * Gets the decimals for an asset, using cache or fetching from RPC.
   */
  async function getDecimals(assetId) {
    const normalized = normalizeAssetId(assetId);
    const now = Date.now();

    // Check cache
    const cached = cache.get(normalized);
    if (cached && cached.expiresAt > now) {
      return cached.decimals;
    }

    // Deduplicate concurrent fetches
    if (pending.has(normalized)) {
      return pending.get(normalized);
    }

    const promise = fetchDecimals(normalized)
      .then(decimals => {
        cache.set(normalized, { decimals, expiresAt: now + ttlMs });
        pending.delete(normalized);
        return decimals;
      })
      .catch(err => {
        pending.delete(normalized);
        throw err;
      });

    pending.set(normalized, promise);
    return promise;
  }

  /**
   * Validates that an amount string doesn't exceed the asset's decimal precision.
   * Returns error message or null if valid.
   */
  async function validateAmountPrecision(amount, assetId) {
    if (typeof amount === 'bigint') return null; // Already in base units
    if (typeof amount !== 'string') return 'pricing.amount must be a decimal numeric string';

    const decimals = await getDecimals(assetId);
    const [, fracPart = ''] = amount.split('.');
    if (fracPart.length > decimals) {
      return `pricing.amount "${amount}" has ${fracPart.length} decimal places but asset "${assetId}" only supports ${decimals}`;
    }
    return null;
  }

  /**
   * Converts a human-readable amount to base units (stroops/atoms) for the asset.
   * Uses BigInt arithmetic exclusively to prevent floating-point inaccuracies.
   */
  async function toBaseUnits(amount, assetId) {
    if (typeof amount === 'bigint') return amount.toString();
    if (typeof amount !== 'string') {
      throw new Error('Amount must be a decimal numeric string or BigInt');
    }

    const decimals = await getDecimals(assetId);
    const [intPart, fracPart = ''] = amount.split('.');
    const sign = intPart.startsWith('-') ? '-' : '';
    const cleanInt = intPart.replace(/^[+-]/, '');
    const truncatedFrac = fracPart.slice(0, decimals);
    const paddedFrac = truncatedFrac.padEnd(decimals, '0');
    return `${sign}${BigInt(cleanInt + paddedFrac).toString()}`;
  }

  /**
   * Converts base units to human-readable amount for the asset.
   */
  function fromBaseUnits(baseUnits, assetDecimals) {
    const decimals = typeof assetDecimals === 'number' ? assetDecimals : 7;
    const str = baseUnits.toString();
    const sign = str.startsWith('-') ? '-' : '';
    const clean = str.replace(/^-/, '');
    if (clean.length <= decimals) {
      const padded = clean.padStart(decimals + 1, '0');
      return `${sign}0.${padded.slice(0, -decimals)}`;
    }
    const intPart = clean.slice(0, -decimals);
    const fracPart = clean.slice(-decimals).replace(/0+$/, '') || '0';
    return `${sign}${intPart}.${fracPart}`;
  }

  /**
   * Clears the cache (for testing).
   */
  function clear() {
    cache.clear();
    pending.clear();
    for (const [asset, decimals] of preloaded) {
      cache.set(normalizeAssetId(asset), { decimals, expiresAt: Infinity });
    }
  }

  return {
    getDecimals,
    validateAmountPrecision,
    toBaseUnits,
    fromBaseUnits,
    clear,
    cache,
  };
}

export default createAssetDecimalsCache;
