import {
  isValidRouteTemplate,
  isValidServiceName,
  isValidIconUrl,
  sanitizeTags,
  extractDiscoveryInfo,
  validateDiscoveryExtension,
} from '@x402/extensions';

/**
 * Distinguishes a hostile routeTemplate (path traversal, protocol smuggling,
 * unparseable percent-encoding) from one that is merely low-quality, such as
 * the wildcard ("*") pattern upstream's own SDK registers by default.
 */
function isHostileRouteTemplate(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return true;
  }
  return decoded.includes('..') || decoded.includes('://');
}

function createResult() {
  return {
    hardDrop: false,
    reason: null,
    softDrops: [],
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
      ? declaration.routeTemplate.match(/\{([^}]+)\}/g)
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
  const extracted = extractDiscoveryInfo(paymentPayload, paymentRequirements, false);
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
    let description = rawDescription.replace(/<[^>]*>?/gm, '').trim();
    if (description.length > 200) {
      description = description.substring(0, 200);
      result.softDrops.push('description_truncated');
    }
    extracted.description = description;
  }

  const rawTags = paymentPayload.resource?.tags;
  if (Array.isArray(rawTags)) {
    const tags = sanitizeTags(rawTags);
    if (tags.length !== rawTags.length || JSON.stringify(tags) !== JSON.stringify(rawTags)) {
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

  if (input.paymentPayload && input.paymentRequirements) {
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
