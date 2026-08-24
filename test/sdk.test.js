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
  console.log('OK testToStroops');
}

function testValidation() {
  const valid = {
    routeTemplate: '/api/data/{id}',
    parameters: { id: 'The data ID' },
    pricing: { amount: '1', asset: 'USDC' },
  };
  assert.strictEqual(validateDiscoveryDeclaration(valid).length, 0);

  const invalid = {
    routeTemplate: '/api/data/{id}',
    pricing: { amount: '1', asset: 'USDC' },
  };
  const errors = validateDiscoveryDeclaration(invalid);
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('Missing description for parameter: id'));
  console.log('OK testValidation');
}

function testCreateResource() {
  const res = createStellarDiscoveryResource({
    routeTemplate: '/api/ping',
    pricing: { amount: '2.5', asset: 'XLM' },
  });
  assert.strictEqual(res.pricing.amount, '25000000');
  assert.strictEqual(res.network, 'stellar:testnet');
  assert.strictEqual(res.scheme, 'exact');
  console.log('OK testCreateResource');
}

function testEmptyPlaceholder() {
  const errors = validateDiscoveryDeclaration({
    routeTemplate: '/x/{ }',
    pricing: { amount: '1', asset: 'XLM' },
    parameters: {},
  });
  assert.ok(errors.some((e) => e.includes('empty parameter')));
  console.log('OK testEmptyPlaceholder');
}

function testDuplicatePlaceholders() {
  const errors = validateDiscoveryDeclaration({
    routeTemplate: '/users/{id}/posts/{id}',
    pricing: { amount: '1', asset: 'XLM' },
    parameters: {},
  });
  const missing = errors.filter((e) => e.includes('Missing description for parameter: id'));
  assert.strictEqual(missing.length, 1);
  console.log('OK testDuplicatePlaceholders');
}

function testConstructorPlaceholder() {
  const errors = validateDiscoveryDeclaration({
    routeTemplate: '/x/{constructor}',
    pricing: { amount: '1', asset: 'XLM' },
    parameters: {},
  });
  assert.ok(errors.some((e) => e.includes('Missing description for parameter: constructor')));
  console.log('OK testConstructorPlaceholder');
}

try {
  testToStroops();
  testValidation();
  testCreateResource();
  testEmptyPlaceholder();
  testDuplicatePlaceholders();
  testConstructorPlaceholder();
} catch (err) {
  console.error('Tests failed:', err);
  process.exit(1);
}
