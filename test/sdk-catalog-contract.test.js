/**
 * Contract test: seller SDK → catalog validator (#703).
 *
 * `createStellarDiscoveryResource` (src/sdk/index.js) is the seller-facing gate
 * that builds a discovery declaration; `validateDiscoveryPolicy`
 * (src/catalog/validation.js) is the facilitator-side gate that admits or
 * rejects that same declaration. They evolve independently, so a declaration
 * the SDK accepts locally must not be refused by the catalog on submission.
 *
 * This suite feeds the SDK's output directly into the validator across a
 * table-driven matrix of networks × assets × schemes × route templates, and
 * asserts the validator's real result shape — `hardDrop`/`reason` plus the
 * `softDrops`, `truncations` and `advisories` lists — rather than assuming it.
 *
 * Two deliberate mismatches are pinned here, not fixed (issue #703 says
 * report them, do not change src/):
 *
 *  1. `{id}` route placeholders and the root path `/` are first-class in the
 *     SDK (and documented in docs/SELLER.md), but upstream
 *     `isValidRouteTemplate` requires at least one character after the leading
 *     `/` and only accepts `[a-zA-Z0-9_/:.~%-]` there, so both are
 *     soft-dropped as `routeTemplate` by the catalog. The row's
 *     `catalogSoftDrops` records that; the declaration is still admitted, but
 *     loses its template.
 *  2. `pricing` (and `routeTemplate`) are mandatory in the SDK but
 *     `validateDiscoveryPolicy` never reads `pricing` on an SDK-shaped
 *     declaration, so deleting it produces only an advisory. The
 *     "known mismatches" suite pins that leniency explicitly.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStellarDiscoveryResource } from '../src/sdk/index.js';
import { validateDiscoveryPolicy } from '../src/catalog/validation.js';

const BASE_URL = 'https://api.example.com';
const PAY_TO = 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6';
const USDC_TESTNET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_PUBNET = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Networks the facilitator serves. */
const NETWORKS = ['stellar:testnet', 'stellar:pubnet'];

/** Only `exact` exists for Stellar today; kept as an axis so a new scheme is one line. */
const SCHEMES = ['exact'];

/**
 * Assets in the `CODE:ISSUER` form the SDK accepts. `asset(network)` keeps the
 * testnet and pubnet issuers distinct, as a real seller's declaration would be.
 */
const ASSETS = [
  { name: 'native XLM', asset: () => 'XLM' },
  {
    name: 'issued USDC',
    asset: network => (network === 'stellar:pubnet' ? USDC_PUBNET : USDC_TESTNET),
  },
];

/**
 * Route-template matrix. `catalogSoftDrops` is the validator's observed
 * handling: empty for templates upstream accepts, `['routeTemplate']` where
 * upstream rejects an SDK-valid template (the root path and brace
 * placeholders). `catalogSuffix` is what the canonical resource URL gains — a
 * soft-dropped template contributes nothing, so the URL stays at the origin
 * root.
 */
const ROUTE_TEMPLATES = [
  {
    name: 'static root',
    template: '/',
    parameters: null,
    catalogSoftDrops: ['routeTemplate'],
    catalogSuffix: '/',
  },
  {
    name: 'static path',
    template: '/api/weather/current',
    parameters: null,
    catalogSoftDrops: [],
    catalogSuffix: '/api/weather/current',
  },
  {
    name: 'nested static path',
    template: '/api/v1/weather/current',
    parameters: null,
    catalogSoftDrops: [],
    catalogSuffix: '/api/v1/weather/current',
  },
  {
    name: 'colon path parameter',
    template: '/api/users/:id',
    parameters: null,
    catalogSoftDrops: [],
    catalogSuffix: '/api/users/:id',
  },
  {
    name: 'brace path parameter',
    template: '/api/users/{id}',
    parameters: { id: 'The user ID' },
    catalogSoftDrops: ['routeTemplate'],
    catalogSuffix: '/',
  },
  {
    name: 'nested brace path parameters',
    template: '/api/v1/users/{userId}/posts/{postId}',
    parameters: { userId: 'The user ID', postId: 'The post ID' },
    catalogSoftDrops: ['routeTemplate'],
    catalogSuffix: '/',
  },
];

/**
 * Builds the declaration through the real SDK, so the test exercises the
 * seller's conversion and defaulting rather than a hand-written fixture.
 */
function declarationFor({ network, scheme, asset, route }) {
  return createStellarDiscoveryResource({
    url: BASE_URL,
    routeTemplate: route.template,
    ...(route.parameters ? { parameters: route.parameters } : {}),
    pricing: { amount: '2.5', asset: asset.asset(network) },
    payTo: PAY_TO,
    network,
    scheme,
  });
}

/** A minimal well-formed declaration used as the baseline for corruption. */
function validDeclaration() {
  return createStellarDiscoveryResource({
    url: BASE_URL,
    routeTemplate: '/api/weather/current',
    pricing: { amount: '1.25', asset: 'XLM' },
    payTo: PAY_TO,
    network: 'stellar:testnet',
    scheme: 'exact',
  });
}

describe('well-formed SDK declarations are admitted by the catalog validator', () => {
  for (const network of NETWORKS) {
    for (const scheme of SCHEMES) {
      for (const asset of ASSETS) {
        for (const route of ROUTE_TEMPLATES) {
          const label = `${network} / ${scheme} / ${asset.name} / ${route.name}`;

          test(label, () => {
            const declaration = declarationFor({ network, scheme, asset, route });

            // The SDK's own contract: human-readable amount in, stroops out.
            assert.equal(declaration.pricing.amount, '25000000', 'SDK converts to stroops');

            const result = validateDiscoveryPolicy(declaration);

            assert.equal(result.hardDrop, false, `${label}: unexpectedly hard-dropped`);
            assert.equal(result.reason, null, `${label}: unexpected rejection reason`);
            // No validation errors: nothing dropped, truncated or advised away
            // beyond the documented brace-template soft drop.
            assert.deepEqual(result.softDrops, route.catalogSoftDrops, `${label}: soft drops`);
            assert.deepEqual(result.truncations, [], `${label}: unexpected truncation`);
            assert.deepEqual(result.advisories, [], `${label}: unexpected advisory`);

            assert.ok(result.resource, `${label}: a resource must be projected`);
            assert.equal(result.resource.network, network, `${label}: network`);
            assert.equal(result.resource.payTo, PAY_TO, `${label}: payTo`);
            assert.equal(
              result.resource.url,
              `${BASE_URL}${route.catalogSuffix}`,
              `${label}: canonical resource URL`,
            );

            if (route.catalogSoftDrops.length === 0) {
              assert.equal(
                result.resource.extensions?.bazaar?.routeTemplate,
                route.template,
                `${label}: accepted template must be preserved`,
              );
            }
          });
        }
      }
    }
  }
});

/**
 * Intentional corruptions of an SDK output, each with the validator's real
 * rejection code. The cases cover hostile route templates, dangerous resource
 * URLs, and bazaar-extension fields removed after the SDK's own validation ran.
 */
const CORRUPTIONS = [
  {
    name: 'path traversal in the route template',
    reason: 'invalid_routeTemplate',
    corrupt: declaration => ({ ...declaration, routeTemplate: '/api/%2e%2e/admin' }),
  },
  {
    name: 'protocol smuggling in the route template',
    reason: 'invalid_routeTemplate',
    corrupt: declaration => ({
      ...declaration,
      routeTemplate: '/api/http://attacker.example',
    }),
  },
  {
    name: 'backslash traversal in the route template',
    reason: 'invalid_routeTemplate',
    corrupt: declaration => ({ ...declaration, routeTemplate: '/api\\..\\admin' }),
  },
  {
    name: 'unparseable percent-encoding in the route template',
    reason: 'invalid_routeTemplate',
    corrupt: declaration => ({ ...declaration, routeTemplate: '/api/%FF/malformed' }),
  },
  {
    name: 'javascript: resource URL',
    reason: 'invalid_url_scheme',
    corrupt: declaration => ({ ...declaration, url: 'javascript:alert(1)' }),
  },
  {
    name: 'ftp: resource URL',
    reason: 'invalid_url_scheme',
    corrupt: declaration => ({ ...declaration, url: 'ftp://example.com/file' }),
  },
  {
    name: 'malformed resource URL',
    reason: 'invalid_url',
    corrupt: declaration => ({ ...declaration, url: 'http://[invalid-ipv6' }),
  },
  {
    name: 'schemeless resource URL',
    reason: 'invalid_url',
    corrupt: declaration => ({ ...declaration, url: 'example.com/api' }),
  },
  {
    name: 'bazaar input missing its mandatory type',
    reason: 'invalid_extension_schema',
    corrupt: declaration => ({ ...declaration, info: { input: { method: 'GET' } } }),
  },
  {
    name: 'bazaar input missing its mandatory method',
    reason: 'invalid_extension_schema',
    corrupt: declaration => ({ ...declaration, info: { input: { type: 'http' } } }),
  },
  {
    name: 'empty bazaar info',
    reason: 'missing_or_invalid_discovery_extension',
    corrupt: declaration => ({ ...declaration, info: {} }),
  },
];

describe('corrupted or incomplete SDK declarations are rejected by the validator', () => {
  for (const corruption of CORRUPTIONS) {
    test(corruption.name, () => {
      const result = validateDiscoveryPolicy(corruption.corrupt(validDeclaration()));

      assert.equal(result.hardDrop, true, 'the corrupt declaration must be hard-dropped');
      assert.equal(result.reason, corruption.reason);
    });
  }
});

describe('known SDK ↔ catalog mismatches (#703: reported, not fixed)', () => {
  test('SDK-mandatory pricing and routeTemplate are advisory-only to the catalog', () => {
    // The SDK refuses to build a declaration without either field, but
    // validateDiscoveryPolicy never reads `pricing` for an SDK-shaped
    // declaration and treats a missing `routeTemplate` as guidance. This test
    // pins the current leniency so a future tightening is a visible change.
    for (const field of ['pricing', 'routeTemplate']) {
      const declaration = { ...validDeclaration() };
      delete declaration[field];

      const result = validateDiscoveryPolicy(declaration);

      assert.equal(result.hardDrop, false, `missing ${field} is currently admitted`);
      assert.equal(result.reason, null, `missing ${field} has no rejection reason`);
      assert.ok(
        result.advisories.includes(`${field}${field === 'pricing' ? ' object' : ''} is required`),
        `missing ${field} is reported as an advisory`,
      );
    }
  });
});
