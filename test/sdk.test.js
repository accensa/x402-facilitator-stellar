import assert from 'assert';
import {
  toStroops,
  validateDiscoveryDeclaration,
  createStellarDiscoveryResource,
} from '../src/sdk/index.js';

function testToStroops() {
  assert.strictEqual(toStroops('1'), '10000000');
  assert.strictEqual(toStroops('0.5'), '5000000');
  assert.strictEqual(toStroops('10.1234567'), '101234567');
  assert.strictEqual(toStroops('0.0000001'), '1');
  assert.strictEqual(toStroops('123.456'), '1234560000');
  console.log('✅ testToStroops passed');
}

function testValidation() {
  const valid = {
    routeTemplate: '/api/data/{id}',
    parameters: { id: 'The data ID' },
    pricing: { amount: '1', asset: 'USDC' },
  };
  assert.strictEqual(validateDiscoveryDeclaration(valid).length, 0);

  const incomplete = {
    routeTemplate: '/api/data/{id}',
    pricing: { amount: '1', asset: 'USDC' },
  };
  const advisories = validateDiscoveryDeclaration(incomplete);
  assert.strictEqual(advisories.length, 1);
  assert.ok(advisories[0].includes('Missing description for parameter: id'));
  console.log('✅ testValidation passed');
}

function testCreateResource() {
  const res = createStellarDiscoveryResource({
    routeTemplate: '/api/ping',
    pricing: { amount: '2.5', asset: 'XLM' },
  });
  assert.strictEqual(res.pricing.amount, '25000000');
  assert.strictEqual(res.network, 'stellar:testnet');
  assert.strictEqual(res.scheme, 'exact');
  console.log('✅ testCreateResource passed');
}

try {
  testToStroops();
  testValidation();
  testCreateResource();
} catch (err) {
  console.error('Tests failed:', err);
  process.exit(1);
}
