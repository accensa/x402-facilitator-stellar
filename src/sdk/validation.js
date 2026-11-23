/**
 * Stellar amounts are 7-decimal fixed point (stroops). Shared by the validator
 * and by toStroops so the two can never disagree on what an amount is.
 *
 * A fractional part longer than STELLAR_DECIMALS is truncated, not rounded —
 * rounding would invent stroops that never existed. (See toStroops.)
 */
export const STELLAR_DECIMALS = 7;

/**
 * Longest description the catalog indexes, in UTF-16 code units. The catalog
 * truncates at this bound; the SDK rejects longer values so a seller is not
 * surprised by a description that was silently shortened after publication.
 * Kept in sync with MAX_DESCRIPTION_LENGTH in src/catalog/validation.js.
 */
export const MAX_DESCRIPTION_LENGTH = 200;

/**
 * A decimal numeric string, optionally signed. Exponent notation, NaN and
 * Infinity are rejected — BigInt can parse '1e7' as neither and a number typed
 * by a human as '1e7' almost certainly does not mean 10,000,000.
 */
const DECIMAL_AMOUNT_RE = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Longest serviceName the catalog keeps. `@x402/extensions` soft-drops a name
 * beyond this bound, which leaves the seller believing they registered a name
 * that was actually discarded. The SDK rejects it at authoring time instead.
 */
const MAX_SERVICE_NAME_LENGTH = 32;

/** Whether a value is a parseable absolute HTTP(S) URL. */
function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

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
  if (typeof amount === 'bigint') {
    if (amount < 0n) {
      return [`pricing.amount must not be negative (got "${amount.toString()}")`];
    }
    return [];
  }
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
    const matches = decl.routeTemplate.match(/\{([^}]+)\}/g) || [];
    const seen = new Set();
    for (const raw of matches) {
      const name = raw.slice(1, -1).trim();
      if (!name) {
        errors.push('routeTemplate contains an empty parameter placeholder');
        continue;
      }
      // Parameter names: start with letter/underscore, then word chars (no dots/spaces)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        errors.push(`Invalid routeTemplate parameter name: ${name}`);
        continue;
      }
      if (seen.has(name)) {
        continue; // report missing description once
      }
      seen.add(name);
      const desc = Object.hasOwn(decl.parameters ?? {}, name) ? decl.parameters[name] : undefined;
      if (typeof desc !== 'string' || desc.trim() === '') {
        errors.push(`Missing description for parameter: ${name}`);
      }
    }
  }

  if (!decl.pricing || typeof decl.pricing !== 'object') {
    errors.push('pricing object is required');
  } else {
    errors.push(...validateAmount(decl.pricing.amount));
    if (!decl.pricing.asset) errors.push('pricing.asset is required');
  }

  // Optional discovery metadata. The catalog expects `tags` to be an array of
  // strings and silently filters bad entries; validating the shape here turns
  // that silent loss into an actionable error before publication.
  if (decl.tags !== undefined) {
    if (!Array.isArray(decl.tags)) {
      errors.push('tags must be an array of strings');
    } else {
      decl.tags.forEach((tag, index) => {
        if (typeof tag !== 'string' || tag.trim() === '') {
          errors.push(`tags[${index}] must be a non-empty string`);
        }
      });
    }
  }

  if (decl.serviceName !== undefined) {
    if (typeof decl.serviceName !== 'string' || decl.serviceName.trim() === '') {
      errors.push('serviceName must be a non-empty string');
    } else if (decl.serviceName.length > MAX_SERVICE_NAME_LENGTH) {
      errors.push(`serviceName must be at most ${MAX_SERVICE_NAME_LENGTH} characters`);
    }
  }

  if (decl.url !== undefined && !isHttpUrl(decl.url)) {
    errors.push('url must be a valid HTTP or HTTPS URL');
  }

  // The catalog truncates an oversized description rather than rejecting it,
  // which silently loses the seller's text. Fail at authoring time instead so
  // they can shorten it deliberately.
  if (typeof decl.description === 'string' && decl.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `description must be at most ${MAX_DESCRIPTION_LENGTH} characters (got ${decl.description.length})`,
    );
  }

  return errors;
}
