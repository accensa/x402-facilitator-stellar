import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscoveryPolicy, validateForCatalog } from '../src/catalog/validation.js';

const requirement = { network: 'stellar:testnet', payTo: 'G123' };

function paymentFor(routeTemplate) {
  return {
    paymentPayload: {
      x402Version: 2,
      resource: { url: 'https://example.test/api/resource' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' } },
          schema: {
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
          routeTemplate,
        },
      },
    },
    paymentRequirements: requirement,
  };
}

test('shared discovery policy keeps CLI and catalog admission aligned', () => {
  const fixtures = [
    { name: 'valid', declaration: { routeTemplate: '/api/resource' }, route: '/api/resource' },
    { name: 'soft drop', declaration: { routeTemplate: '*' }, route: '*' },
    {
      name: 'hard drop',
      declaration: { routeTemplate: '/api/%2e%2e/private' },
      route: '/api/%2e%2e/private',
    },
  ];

  for (const fixture of fixtures) {
    const seller = validateDiscoveryPolicy(fixture.declaration, requirement);
    const catalog = validateForCatalog(...Object.values(paymentFor(fixture.route)));

    assert.equal(catalog.hardDrop, seller.hardDrop, fixture.name);
    if (fixture.name === 'hard drop') {
      assert.equal(seller.reason, 'invalid_routeTemplate');
      assert.equal(catalog.reason, 'invalid_routeTemplate');
    }
    if (fixture.name === 'soft drop') {
      assert.ok(seller.softDrops.includes('routeTemplate'));
      assert.ok(catalog.softDrops.includes('routeTemplate'));
    }
  }
});
