/**
 * Semantic MCP resources over the facilitator catalog (#391).
 *
 * Tools take arguments and return JSON; resources take a URI and return content
 * the client can attach to a model's context directly. For an agent deciding
 * what to pay for, the resource form is the more natural fit — a client can
 * pre-fetch `x402://catalog/search?q=weather` and drop it into a prompt without
 * inventing a tool call.
 *
 * URI scheme
 * ----------
 *   x402://catalog/resources            the whole public catalog
 *   x402://catalog/search?q={query}     ranked search (template)
 *   x402://catalog/resource?url={url}   one resource's metadata + pricing (template)
 *   x402://catalog/network/{network}    catalog summary for one network (template)
 *
 * Every template parameter is validated by `src/mcp/sanitize.js` before it
 * reaches a URL. That matters more here than for prompts: these parameters
 * become part of an outbound HTTP request to the facilitator, so an unvalidated
 * `url` is a request-forgery primitive and an unvalidated `q` is a way to move
 * the query string boundary (`#`, `&`, CRLF). `URL`/`URLSearchParams` encoding
 * handles the encoding; the validators handle whether the value is allowed at
 * all.
 *
 * The catalog is open — any seller can publish a resource — so resource content
 * is returned as-is to the client (it is data the client asked for, not text
 * this server injects into its own instructions) but is neutralised of
 * invisible characters on the way out. See `frameUntrusted` for the framing
 * used when such content is embedded in a *prompt*.
 */
import {
  McpInputError,
  assertHttpUrl,
  assertNetwork,
  assertSafeText,
  stripUnsafeCharacters,
} from './sanitize.js';

export const RESOURCE_SCHEME = 'x402:';
const JSON_MIME = 'application/json';

/** Fixed (non-templated) resources, in the MCP wire shape. */
const STATIC_RESOURCES = [
  {
    uri: `${RESOURCE_SCHEME}//catalog/resources`,
    name: 'x402 catalog',
    description:
      'Every publicly listed x402 resource known to this facilitator: service name, description, payee, price, and network.',
    mimeType: JSON_MIME,
  },
];

/** Parameterised resources, advertised through `resources/templates/list`. */
const RESOURCE_TEMPLATES = [
  {
    uriTemplate: `${RESOURCE_SCHEME}//catalog/search?q={query}`,
    name: 'catalog search',
    description:
      'Ranked catalog search. Substitute {query} with natural language. Uses the same ranking as the /discovery/search endpoint, including recency decay and payment-verified boost.',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: `${RESOURCE_SCHEME}//catalog/resource?url={url}`,
    name: 'catalog resource',
    description:
      'Metadata and pricing for one resource. Substitute {url} with the resource URL, percent-encoded.',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: `${RESOURCE_SCHEME}//catalog/network/{network}`,
    name: 'catalog network summary',
    description:
      'Catalog summary for one Stellar network: resource count and the networks present. Substitute {network} with e.g. stellar:testnet.',
    mimeType: JSON_MIME,
  },
];

/**
 * The `resources/list` payload.
 * @returns {{resources: object[]}}
 */
export function listResources() {
  return { resources: STATIC_RESOURCES.map(r => ({ ...r })) };
}

/**
 * The `resources/templates/list` payload.
 * @returns {{resourceTemplates: object[]}}
 */
export function listResourceTemplates() {
  return { resourceTemplates: RESOURCE_TEMPLATES.map(t => ({ ...t })) };
}

/**
 * Every advertised resource URI, static and templated. Used by the CLI to
 * document what a client can read.
 * @returns {string[]}
 */
export function allResourceUris() {
  return [...STATIC_RESOURCES.map(r => r.uri), ...RESOURCE_TEMPLATES.map(t => t.uriTemplate)];
}

/**
 * Splits an `x402://` URI into its scheme, path, and query parameters.
 *
 * Parsed with `URL` rather than by hand so percent-decoding and query
 * splitting follow the platform rather than a local regex.
 *
 * @param {string} uri
 * @returns {{path: string, params: URLSearchParams}}
 * @throws {McpInputError} when the URI is not a well-formed x402 URI
 */
export function parseResourceUri(uri) {
  const raw = assertSafeText(uri, { field: 'uri', required: true, maxLength: 2048 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpInputError('Resource uri must be a valid x402:// URI', { field: 'uri' });
  }
  if (parsed.protocol !== RESOURCE_SCHEME) {
    throw new McpInputError(`Resource uri must use the ${RESOURCE_SCHEME} scheme`, {
      field: 'uri',
    });
  }
  return { path: parsed.hostname + parsed.pathname, params: parsed.searchParams };
}

/**
 * Bounds on `limit` for `x402://catalog/search`.
 *
 * The tool surface advertises `max 100` (`src/mcp/cli.js`, `search_resources`),
 * so the resource has to enforce the same ceiling. Defined once so the pattern
 * hint, the enforced range and the rejection message cannot drift apart.
 */
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 100;
const SEARCH_LIMIT_HINT = `expected a number between ${SEARCH_LIMIT_MIN} and ${SEARCH_LIMIT_MAX}`;

/**
 * Reads one semantic resource.
 *
 * @param {string} uri - an `x402://` URI, with template parameters substituted
 * @param {object} deps
 * @param {(path: string, params?: object) => Promise<object>} deps.fetchDiscovery
 *   the caller's facilitator HTTP helper (see `src/mcp/cli.js`)
 * @returns {Promise<{contents: Array<{uri: string, mimeType: string, text: string}>}>}
 * @throws {McpInputError} for an unknown URI or a malformed parameter
 */
export async function readResource(uri, { fetchDiscovery } = {}) {
  if (typeof fetchDiscovery !== 'function') {
    throw new McpInputError('readResource requires a fetchDiscovery helper', { field: 'uri' });
  }
  const { path, params } = parseResourceUri(uri);

  if (path === 'catalog/resources') {
    const data = await fetchDiscovery('/discovery/resources');
    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: stringify(data),
        },
      ],
    };
  }

  if (path === 'catalog/search') {
    // Validated, then passed as a value: URLSearchParams in fetchDiscovery does
    // the encoding, so the query can never terminate the query string or add a
    // parameter. The URI spells it `q` (shorter to type); the facilitator's
    // parameter is `query`, and the mapping is made here rather than by the
    // caller so the two names cannot drift apart.
    const query = assertSafeText(params.get('q'), {
      field: 'q',
      required: true,
      maxLength: 256,
    });
    // The regex is deliberately left as-is: non-numeric and oversized input
    // must fail as malformed before the range below is consulted. It admits
    // 0 and 999, which is what the range check rejects — and the raw value is
    // never echoed back, only the bound.
    const limit = assertSafeText(params.get('limit'), {
      field: 'limit',
      maxLength: 4,
      pattern: /^\d{1,3}$/,
      patternHint: SEARCH_LIMIT_HINT,
    });
    const limitValue = limit === '' ? null : Number(limit);
    if (limitValue !== null && (limitValue < SEARCH_LIMIT_MIN || limitValue > SEARCH_LIMIT_MAX)) {
      throw new McpInputError(
        `'limit' must be between ${SEARCH_LIMIT_MIN} and ${SEARCH_LIMIT_MAX}`,
        {
          field: 'limit',
        },
      );
    }
    const data = await fetchDiscovery('/discovery/search', {
      query,
      ...(limitValue === null ? {} : { limit: limitValue }),
    });
    return {
      contents: [{ uri, mimeType: JSON_MIME, text: stringify(data) }],
    };
  }

  if (path === 'catalog/resource') {
    const target = assertHttpUrl(params.get('url'), { field: 'url' });
    const toolName = assertSafeText(params.get('toolName'), {
      field: 'toolName',
      maxLength: 128,
    });
    const data = await fetchDiscovery('/discovery/resources', {
      url: target.toString(),
      ...(toolName ? { toolName } : {}),
    });

    // An empty result is a legitimate answer to "read this resource", and a
    // client that asked should be told so rather than handed a 404-shaped hole.
    const empty = !data || !Array.isArray(data.resources) || data.resources.length === 0;
    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: stringify(
            empty
              ? { error: 'not_found', message: 'No catalog resource matches that url.' }
              : data.resources[0],
          ),
        },
      ],
    };
  }

  const networkMatch = /^catalog\/network\/(.+)$/.exec(path);
  if (networkMatch) {
    const network = assertNetwork(decodeURIComponent(networkMatch[1]));
    const data = await fetchDiscovery('/discovery/resources', { network });
    const items = Array.isArray(data?.resources) ? data.resources : [];
    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: stringify({
            network,
            count: items.length,
            resources: items.map(item => ({
              url: item.url,
              serviceName: item.serviceName,
              type: item.type,
              payTo: item.payTo,
            })),
          }),
        },
      ],
    };
  }

  throw new McpInputError(`Unknown resource uri: ${uri}`, {
    uri,
    knownResources: allResourceUris(),
  });
}

/** Byte budget for MCP resource response payloads to avoid stdio transport buffer stalls (#695). */
export const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KiB
/** Maximum recursion depth for scrubbing extension objects and nested structures (#695). */
export const MAX_DEPTH = 10;
/** Explicit marker embedded in serialized payload when budget is exceeded (#695). */
export const TRUNCATION_MARKER = '[truncated]';

/**
 * Serialises catalog data for a resource body.
 *
 * Seller-controlled strings are stripped of invisible characters on the way
 * out. Dropping pretty-printing overhead on the transport path and introducing
 * explicit payload byte budget and recursion depth guards ensures agents do
 * not hang when reading catalog payloads (#695).
 *
 * @param {unknown} data
 * @param {number} [maxBytes=MAX_PAYLOAD_BYTES]
 * @returns {string}
 */
export function stringify(data, maxBytes = MAX_PAYLOAD_BYTES) {
  const scrubbed = scrub(data);
  const compact = JSON.stringify(scrubbed);

  if (Buffer.byteLength(compact, 'utf8') <= maxBytes) {
    return compact;
  }

  // Payload exceeded budget: embed explicit truncation indicator cleanly (#695)
  if (scrubbed && typeof scrubbed === 'object') {
    // 1. If it's an array
    if (Array.isArray(scrubbed)) {
      let low = 0;
      let high = scrubbed.length;
      let best = null;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = [
          ...scrubbed.slice(0, mid),
          { _truncated: true, _marker: TRUNCATION_MARKER },
        ];
        const str = JSON.stringify(candidate);
        if (Buffer.byteLength(str, 'utf8') <= maxBytes) {
          best = str;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best) return best;
    } else {
      // 2. If it's an object with an array field (e.g. resources, results, items)
      const arrayKey = Object.keys(scrubbed).find(k => Array.isArray(scrubbed[k]));
      if (arrayKey) {
        const origArr = scrubbed[arrayKey];
        let low = 0;
        let high = origArr.length;
        let best = null;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = {
            ...scrubbed,
            [arrayKey]: origArr.slice(0, mid),
            _truncated: true,
            _marker: TRUNCATION_MARKER,
          };
          const str = JSON.stringify(candidate);
          if (Buffer.byteLength(str, 'utf8') <= maxBytes) {
            best = str;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        if (best) return best;
      }

      // 3. Truncate long string properties in the object
      const truncatedObj = { ...scrubbed, _truncated: true, _marker: TRUNCATION_MARKER };
      for (const [k, v] of Object.entries(truncatedObj)) {
        if (typeof v === 'string' && v.length > 50) {
          truncatedObj[k] = v.slice(0, 50) + '... ' + TRUNCATION_MARKER;
        }
      }
      const str = JSON.stringify(truncatedObj);
      if (Buffer.byteLength(str, 'utf8') <= maxBytes) {
        return str;
      }

      // 4. Return minimal structured truncation indicator
      const minimal = {
        _truncated: true,
        _marker: TRUNCATION_MARKER,
        error: 'payload_too_large',
        message: `Payload exceeded byte budget of ${maxBytes} bytes`,
      };
      const minStr = JSON.stringify(minimal);
      if (Buffer.byteLength(minStr, 'utf8') <= maxBytes) {
        return minStr;
      }
    }
  }

  // Fallback string truncation with marker
  const marker = `... ${TRUNCATION_MARKER}`;
  const markerLen = Buffer.byteLength(marker, 'utf8');
  if (maxBytes >= markerLen) {
    const sliceBytes = maxBytes - markerLen;
    const buf = Buffer.from(compact, 'utf8');
    return buf.subarray(0, sliceBytes).toString('utf8') + marker;
  }
  return TRUNCATION_MARKER.slice(0, maxBytes);
}

/**
 * Recursively strips unsafe characters from strings in a JSON-ish structure,
 * guarded by MAX_DEPTH to prevent call-stack exhaustion (#695).
 *
 * @param {unknown} value
 * @param {number} [depth=0]
 * @returns {unknown}
 */
export function scrub(value, depth = 0) {
  if (typeof value === 'string') return stripUnsafeCharacters(value);
  if (value === null || typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) {
    return '[Truncated: depth limit exceeded]';
  }

  if (Array.isArray(value)) {
    return value.map(item => scrub(item, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[stripUnsafeCharacters(k)] = scrub(v, depth + 1);
  }
  return out;
}
