import { validateDiscoveryDeclaration, validateAmount, STELLAR_DECIMALS } from './validation.js';
export { validateDiscoveryDeclaration };
export { parsePayUri, buildPayUri, payUriFromRequirements, Sep7Error } from './sep7.js';

/**
 * Converts a human-readable amount to stroops (1e-7 fixed point).
 *
 * Accepted input shapes: a decimal numeric string ('2.5', '+0.5', '0') or a
 * BigInt stroop count. Anything else is rejected rather than coerced — a
 * JavaScript number has usually already lost precision before this function
 * sees it.
 *
 * A fractional part longer than the asset's decimals is rejected (not truncated)
 * to prevent silent precision loss. For native XLM (7 decimals), the default
 * maintains backward-compatible truncation behavior.
 *
 * Throws (never coerces) on non-numeric input, negatives, and number inputs.
 * Zero is a valid amount — see validateAmount.
 */
export function toStroops(amount, assetDecimals = STELLAR_DECIMALS) {
  const errors = validateAmount(amount, assetDecimals);
  if (errors.length > 0) {
    throw new Error(errors[0]);
  }
  if (typeof amount === 'bigint') return amount.toString();
  const [intPart, fracPart = ''] = amount.split('.');
  const truncatedFrac = fracPart.slice(0, assetDecimals);
  const paddedFrac = truncatedFrac.padEnd(assetDecimals, '0');
  return BigInt(intPart.replace(/^\+/, '') + paddedFrac).toString();
}

/**
 * Creates a discovery resource declaration with Stellar-shaped ergonomics.
 * Validates the input and converts human-readable amounts to stroops.
 */
export function createStellarDiscoveryResource(params) {
  const errors = validateDiscoveryDeclaration(params);
  if (errors.length > 0) {
    throw new Error('Invalid discovery declaration:\n - ' + errors.join('\n - '));
  }

  return {
    ...params,
    network: params.network || 'stellar:testnet',
    scheme: params.scheme || 'exact',
    pricing: {
      ...params.pricing,
      amount: toStroops(params.pricing.amount),
    },
  };
}
