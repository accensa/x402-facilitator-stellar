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
    // A non-empty result is not the same thing as a match: `/discovery/resources`
    // filters by url, and that filter also matches prefixes, trailing slashes and
    // other normalised forms. Returning `resources[0]` unchecked answers a request
    // for one uri with another seller's price and payee (#690), so the first row
    // has to be the requested resource or it is not a result at all.
    const items = data && Array.isArray(data.resources) ? data.resources : [];
    const first = items[0];
    const notFound = { error: 'not_found', message: 'No catalog resource matches that url.' };
    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: stringify(
            first && matchesRequestedResource(target, toolName, first) ? first : notFound,
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

/**
 * Whether a catalog row is the resource that was asked for.
 *
 * The url comparison is on `toString()` so both sides are normalised the same
 * way, and it is exact: `https://example.com/a` is not `https://example.com/a/b`,
 * `https://example.com/a/` or `https://example.com/a?ref=x`. A row whose url is
 * missing or unparseable cannot be the requested resource, and the value is
 * never echoed — it is seller-controlled text on its way into an agent's context.
 *
 * `toolName` only narrows a request that named a tool; a row that names a
 * different one is a different resource at the same url.
 *
 * @param {URL} target - the validated requested url
 * @param {string|undefined} toolName - the validated requested tool name, if any
 * @param {object} item - a row from `/discovery/resources`
 * @returns {boolean}
 */
function matchesRequestedResource(target, toolName, item) {
  let found;
  try {
    found = new URL(String(item?.url)).toString();
  } catch {
    return false;
  }
  if (found !== target.toString()) return false;
  if (toolName && typeof item?.toolName === 'string' && item.toolName !== toolName) return false;
  return true;
}

/**
 * Serialises catalog data for a resource body.
 *
 * Seller-controlled strings are stripped of invisible characters on the way
 * out. This is not a security boundary on its own — the client asked for this
 * data — it is hygiene: a zero-width or ANSI sequence in a description is
 * either an attempt to hide something from whoever reads the transcript, or an
 * accident that makes the resource unreadable. Either way it has no business in
 * a resource body.
 *
 * @param {unknown} data
 * @returns {string}
 */
function stringify(data) {
  return JSON.stringify(scrub(data), null, 2);
}

/**
 * Recursively strips unsafe characters from strings in a JSON-ish structure.
 * @param {unknown} value
 * @returns {unknown}
 */
function scrub(value) {
  if (typeof value === 'string') return stripUnsafeCharacters(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[stripUnsafeCharacters(k)] = scrub(v);
    return out;
  }
  return value;
}
