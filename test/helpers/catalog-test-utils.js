/**
 * Modular helper components and fixtures for catalog identity and unit tests.
 */
import assert from 'node:assert/strict';

/**
 * Creates an HTTP resource listing fixture with configurable overrides.
 */
export function createHttpListing(overrides = {}) {
  return {
    type: 'http',
    url: 'https://api.example.com/endpoint',
    serviceName: 'HTTP Service',
    description: 'An exemplary HTTP API resource',
    payTo: 'G1234567890EXAMPLE',
    scheme: 'exact',
    network: 'stellar:testnet',
    ...overrides,
  };
}

/**
 * Creates an MCP resource listing fixture with configurable overrides.
 */
export function createMcpListing(overrides = {}) {
  return {
    type: 'mcp',
    url: 'https://mcp.example.com',
    toolName: 'default_tool',
    serviceName: 'MCP Tool Service',
    description: 'An exemplary MCP tool resource',
    payTo: 'G1234567890EXAMPLE',
    scheme: 'exact',
    network: 'stellar:testnet',
    ...overrides,
  };
}

/**
 * Seeds a MemoryCatalogStore with a collection of resources sequentially.
 */
export async function seedCatalog(store, resources, source = 'manual') {
  const seeded = [];
  for (const resource of resources) {
    const entry = await store.upsertResource(resource, source);
    seeded.push(entry);
  }
  return seeded;
}

/**
 * Asserts that a catalog resource entry matches expected properties and invariants.
 */
export function assertResourceMatch(actual, expected) {
  assert.ok(actual, 'Resource should be found and non-null');
  assert.equal(actual.url, expected.url, 'Resource url must match');
  assert.equal(actual.type, expected.type, 'Resource type must match');
  if (expected.toolName !== undefined) {
    assert.equal(actual.toolName, expected.toolName, 'Resource toolName must match');
  }
  if (expected.serviceName !== undefined) {
    assert.equal(actual.serviceName, expected.serviceName, 'Resource serviceName must match');
  }
  if (expected.payTo !== undefined) {
    assert.equal(actual.payTo, expected.payTo, 'Resource payTo must match');
  }
  assert.ok(actual.first_seen_at instanceof Date, 'first_seen_at must be a valid Date');
  assert.ok(actual.last_seen_at instanceof Date, 'last_seen_at must be a valid Date');
}
