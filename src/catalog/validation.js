import {
  isValidRouteTemplate,
  isValidServiceName,
  isValidIconUrl,
  sanitizeTags,
  extractDiscoveryInfo,
  validateDiscoveryExtension,
} from '@x402/extensions';
import { validateAmount } from '../sdk/validation.js';

// Pre-compiled regex patterns to avoid recompilation overhead and garbage collection pressure
const ROUTE_PARAM_REGEX = /\{([^}]+)\}/g;

/**
 * Markup in a description, in either of the two forms that matter (#217).
 *
 * The old guard was a tag-stripping regex (`/<[^>]*>?/gm`), which is a
 * sanitizer, not a boundary: it cannot be. `<scr<script>ipt>` strips to
 * `<script>`; `<img src=x onerror=alert(1)>` loses the tag but the payload
 * text survives; `&lt;script&gt;` is untouched and is markup to every consumer
 * that entity-decodes; and a truncated `<img src=x onerror=...` with no
 * closing `>` matches the optional-tail alternative and disappears, hiding
 * that anything was refused at all.
 *
 * Refusing is the only defensible policy: a description is prose, and prose
 * that needs angle brackets to say what it means is not something the catalog
 * can safely store. `&` is matched only when it begins a markup entity
 * (`&lt;`, `&gt;`, `&#60;`, `&#x3c;`), so "Tom & Jerry" still passes. Both
 * entity spellings HTML allows are covered — a leading `0*` for zero-padded
 * numerics and `[xX]` for either hex prefix, since `&#X3C;` is as valid as
 * `&#x3c;` and would otherwise be the one way through.
 *
 * Deliberately not a global regex: it is used with `.test()`, and a `g` flag
 * would make that call stateful across invocations.
 */
const MARKUP_PATTERN = /<[a-zA-Z/!]|&(?:lt|gt|#0*6[02]|#[xX]0*3[cC]);/;

/** Longest description the catalog will index, in UTF-16 code units. */
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Truncates a description to at most `maxLength` UTF-16 code units without
 * splitting a surrogate pair (#218).
 *
 * `String.prototype.slice`/`substring` cut on code-unit boundaries, so a cut
 * landing between the two halves of an astral character (an emoji in a listing
 * blurb) leaves an unpaired surrogate behind. That is not valid UTF-16: it
 * survives `JSON.stringify` as a lone `\udXXX` escape which conformant clients
 * reject or render as U+FFFD, and it cannot be round-tripped through a
 * `jsonb` column. Losing one code unit off the end is strictly better than
 * emitting a value that is not text.
 *
 * The fast path returns the input untouched when it already fits, so the
 * common short description pays nothing for the guard.
 */
function truncateDescription(value, maxLength = MAX_DESCRIPTION_LENGTH) {
  if (value.length <= maxLength) return value;
  // Walking back one unit when the cut lands on a high surrogate keeps the
  // pair whole; the result is then at most maxLength - 1 code units long.
  const boundary = value.charCodeAt(maxLength - 1);
  const end = boundary >= 0xd800 && boundary <= 0xdbff ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}

/**
 * Distinguishes a hostile routeTemplate (path traversal, protocol smuggling,
 * unparseable percent-encoding) from one that is merely low-quality, such as
 * the wildcard ("*") pattern upstream's own SDK registers by default.
 */
function isHostileRouteTemplate(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  // Fast path: avoid expensive decodeURIComponent native call when no encoded characters or path traversal markers exist
  if (
    !value.includes('%') &&
    !value.includes('..') &&
    !value.includes('://') &&
    !value.includes('\\')
  ) {
    return false;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return true;
  }
  return decoded.includes('..') || decoded.includes('://') || decoded.includes('\\');
}

function createResult() {
  return {
    hardDrop: false,
    reason: null,
    softDrops: [],
    // Fields that were kept but shortened. Reported separately from
    // softDrops (#219): a drop means the seller's value is gone, a
    // truncation means part of it is. Folding the two together told a
    // seller "description_truncated was dropped", which is not a thing
    // that can happen — and left a caller unable to tell which of its
    // fields had actually been discarded.
    truncations: [],
    advisories: [],
    resource: null,
  };
}

function addAdvisories(result, declaration) {
  if (!declaration.routeTemplate) {
    result.advisories.push('routeTemplate is required');
  }

  const matches =
    typeof declaration.routeTemplate === 'string'
      ? declaration.routeTemplate.match(ROUTE_PARAM_REGEX)
      : null;
  if (matches) {
    for (const match of matches) {
      const parameter = match.slice(1, -1);
      if (!declaration.parameters?.[parameter]) {
        result.advisories.push(`Missing description for parameter: ${parameter}`);
      }
    }
  }

  if (!declaration.pricing || typeof declaration.pricing !== 'object') {
    result.advisories.push('pricing object is required');
  } else {
    if (!declaration.pricing.amount) result.advisories.push('pricing.amount is required');
    if (!declaration.pricing.asset) result.advisories.push('pricing.asset is required');
  }
}

function validatePolicy(paymentPayload, paymentRequirements, result) {
  let extracted;
  try {
    extracted = extractDiscoveryInfo(paymentPayload, paymentRequirements, false);
  } catch (err) {
    result.hardDrop = true;
    result.reason =
      err?.code === 'ERR_INVALID_URL' || err?.message?.includes('Invalid URL')
        ? 'invalid_url'
        : 'missing_or_invalid_discovery_extension';
    return result;
  }
  if (!extracted) {
    result.hardDrop = true;
    result.reason = 'missing_or_invalid_discovery_extension';
    return result;
  }

  const rawBazaar = paymentPayload.extensions?.bazaar;
  if (rawBazaar) {
    const schemaResult = validateDiscoveryExtension(rawBazaar);
    if (!schemaResult.valid) {
      result.hardDrop = true;
      result.reason = 'invalid_extension_schema';
      return result;
    }
    // Validate pricing.amount format (#225) to prevent toStroops from throwing later
    if (rawBazaar.pricing?.amount !== undefined) {
      const amountErrors = validateAmount(rawBazaar.pricing.amount);
      if (amountErrors.length > 0) {
        result.hardDrop = true;
        result.reason = 'invalid_pricing_amount';
        return result;
      }
    }
  }

  const rawTemplate = rawBazaar?.routeTemplate;
  if (rawTemplate !== undefined && !isValidRouteTemplate(rawTemplate)) {
    if (isHostileRouteTemplate(rawTemplate)) {
      result.hardDrop = true;
      result.reason = 'invalid_routeTemplate';
      return result;
    }
    result.softDrops.push('routeTemplate');
  }

  const rawServiceName = paymentPayload.resource?.serviceName;
  if (rawServiceName !== undefined) {
    if (!isValidServiceName(rawServiceName)) {
      result.softDrops.push('serviceName');
      delete extracted.serviceName;
    } else {
      extracted.serviceName = rawServiceName;
    }
  }

  const rawIconUrl = paymentPayload.resource?.iconUrl;
  if (rawIconUrl !== undefined) {
    if (!isValidIconUrl(rawIconUrl)) {
      result.softDrops.push('iconUrl');
      delete extracted.iconUrl;
    } else {
      extracted.iconUrl = rawIconUrl;
    }
  }

  const rawDescription = paymentPayload.resource?.description;
  if (typeof rawDescription === 'string') {
    const description = rawDescription.trim();
    // The `includes` guard is a fast path only: every description without a
    // `<` or `&` skips the regex entirely, so ordinary prose (the overwhelming
    // majority) pays nothing. The regex is the decision, not this test.
    if (
      (description.includes('<') || description.includes('&')) &&
      MARKUP_PATTERN.test(description)
    ) {
      result.softDrops.push('description');
      // extractDiscoveryInfo has already populated `extracted.description`
      // from the same source field, so refusing means deleting it — not
      // merely declining to assign it. Without this the refused markup is
      // still stored, via the copy this function never wrote.
      delete extracted.description;
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      // Kept, not dropped: shortening is not discarding (#219).
      extracted.description = truncateDescription(description);
      result.truncations.push('description');
    } else {
      extracted.description = description;
    }
  }

  const rawTags = paymentPayload.resource?.tags;
  if (Array.isArray(rawTags)) {
    // sanitizeTags returns undefined (not []) when every entry is filtered
    // out, e.g. all tags are oversized or duplicates.
    const tags = sanitizeTags(rawTags) ?? [];
    let isFiltered = tags.length !== rawTags.length;
    if (!isFiltered) {
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] !== rawTags[i]) {
          isFiltered = true;
          break;
        }
      }
    }
    if (isFiltered) {
      result.softDrops.push('tags_filtered');
    }
    extracted.tags = tags;
  }

  result.resource = {
    type: extracted.toolName ? 'mcp' : 'http',
    url: extracted.resourceUrl,
    toolName: extracted.toolName,
    serviceName: extracted.serviceName,
    description: extracted.description,
    tags: extracted.tags,
    iconUrl: extracted.iconUrl,
    scheme: extracted.discoveryInfo?.scheme,
    network: paymentRequirements.network,
    extensions: extracted.extensions,
    payTo: paymentRequirements.payTo,
  };

  if (result.resource.url) {
    try {
      const parsedUrl = new URL(result.resource.url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        result.hardDrop = true;
        result.reason = 'invalid_url_scheme';
        return result;
      }
    } catch {
      result.hardDrop = true;
      result.reason = 'invalid_url';
      return result;
    }
  }

  return result;
}

/**
 * Runs the authoritative catalog policy. Payment-shaped values are validated
 * directly; SDK declarations are adapted into the same Bazaar extension shape.
 * Seller-only guidance is returned as advisories and never changes admission.
 */
export function validateDiscoveryPolicy(input, paymentRequirements = {}) {
  const result = createResult();
  if (!input || typeof input !== 'object') {
    result.hardDrop = true;
    result.reason = 'invalid_declaration';
    return result;
  }

  if (
    Object.prototype.hasOwnProperty.call(input, 'paymentPayload') ||
    Object.prototype.hasOwnProperty.call(input, 'paymentRequirements')
  ) {
    if (!input.paymentPayload || typeof input.paymentPayload !== 'object') {
      result.hardDrop = true;
      result.reason = 'missing_or_invalid_discovery_extension';
      return result;
    }
    if (!input.paymentRequirements || typeof input.paymentRequirements !== 'object') {
      result.hardDrop = true;
      result.reason = 'invalid_declaration';
      return result;
    }
    return validatePolicy(input.paymentPayload, input.paymentRequirements, result);
  }

  addAdvisories(result, input);
  const declaration = {
    x402Version: 2,
    resource: {
      url: input.url || input.resourceUrl || 'https://discovery.invalid',
      serviceName: input.serviceName,
      description: input.description,
      iconUrl: input.iconUrl,
      tags: input.tags,
    },
    extensions: {
      bazaar: {
        info: input.info || {
          input: { type: input.type || 'http', method: input.method || 'GET' },
        },
        schema: input.schema || {
          type: 'object',
          properties: {
            input: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                method: { type: 'string' },
              },
              required: ['type', 'method'],
            },
          },
          required: ['input'],
        },
        routeTemplate: input.routeTemplate,
      },
    },
  };

  const policy = validatePolicy(
    declaration,
    {
      network: input.network || paymentRequirements.network || 'stellar:testnet',
      payTo: input.payTo || paymentRequirements.payTo || '',
    },
    result,
  );
  return policy;
}

export function validateForCatalog(paymentPayload, paymentRequirements) {
  return validateDiscoveryPolicy({ paymentPayload, paymentRequirements });
}
