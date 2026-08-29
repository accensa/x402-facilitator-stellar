/**
 * Stellar amounts are 7-decimal fixed point (stroops). Shared by the validator
 * and by toStroops so the two can never disagree on what an amount is.
 *
 * A fractional part longer than STELLAR_DECIMALS is truncated, not rounded —
 * rounding would invent stroops that never existed. (See toStroops.)
 */
export const STELLAR_DECIMALS = 7;

/**
 * A decimal numeric string, optionally signed. Exponent notation, NaN and
 * Infinity are rejected — BigInt can parse '1e7' as neither and a number typed
 * by a human as '1e7' almost certainly does not mean 10,000,000.
 */
const DECIMAL_AMOUNT_RE = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * The one place the amount policy is decided. Returns a list of error strings
 * (empty when the amount is acceptable).
 *
 * Zero is a valid price by policy: a free endpoint is a coherent thing for a
 * discovery catalog to list. A number is not a valid input shape — the caller
 * has almost certainly already lost precision before this function sees it
 * (Number('123456789012345678.9') rounds), so only decimal strings and BigInt
 * (an exact stroop count) are accepted. A fraction longer than a stroop is
 * truncated on conversion (in toStroops), never rounded.
 */
export function validateAmount(amount) {
  if (amount === undefined || amount === null || amount === '') {
    return ['pricing.amount is required'];
  }
  if (typeof amount === 'bigint') return [];
  if (typeof amount !== 'string') {
    return [
      'pricing.amount must be a decimal numeric string; numbers lose precision before stroop conversion',
    ];
  }
  if (!DECIMAL_AMOUNT_RE.test(amount)) {
    return [`pricing.amount "${amount}" is not a valid decimal numeric string`];
  }
  if (amount.startsWith('-')) {
    return [`pricing.amount must not be negative (got "${amount}")`];
  }
  return [];
}

export function validateDiscoveryDeclaration(decl) {
  const errors = [];
  if (!decl || typeof decl !== 'object') {
    return ['Declaration must be an object'];
  }
  if (!decl.routeTemplate) errors.push('routeTemplate is required');

  // Check for parameter descriptions if parameters exist in template
  if (decl.routeTemplate) {
    const matches = decl.routeTemplate.match(/\{([^}]+)\}/g);
    if (matches) {
      const params = matches.map(m => m.slice(1, -1));
      params.forEach(p => {
        if (!decl.parameters || !decl.parameters[p]) {
          errors.push(`Missing description for parameter: ${p}`);
        }
      });
    }
  }

  if (!decl.pricing || typeof decl.pricing !== 'object') {
    errors.push('pricing object is required');
  } else {
    errors.push(...validateAmount(decl.pricing.amount));
    if (!decl.pricing.asset) errors.push('pricing.asset is required');
  }

  return errors;
}
