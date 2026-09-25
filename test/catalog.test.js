/**
 * Catalog identity: how MemoryCatalogStore keys the resources it holds.
 *
 * A listing's identity is its URL plus, for MCP resources only, the tool name
 * (see MemoryCatalogStore#_key). One MCP server exposes many paid tools at a
 * single URL, so keying on URL alone would let the second tool overwrite the
 * first. HTTP resources have no tool, so their URL alone identifies them.
 *
 * Search, listing and policy behaviour have their own suites
 * (catalog.search / catalog.list / catalog.policy); this file covers identity
 * only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogStore } from '../src/catalog/memory.js';

test('catalog keys MCP resources by url and tool name, HTTP by url', async () => {
  // No embeddingsUrl: upserts skip background embedding, so no network and
  // no pending promises to flush.
  const store = new MemoryCatalogStore();

  // HTTP resource: identity is the URL alone.
  await store.upsertResource({ type: 'http', url: 'http://api.ex/1', serviceName: 'A' });

  // MCP resources: same URL, different tools, so two distinct listings.
  await store.upsertResource({
    type: 'mcp',
    url: 'http://mcp.ex',
    toolName: 'tool1',
    serviceName: 'B',
  });
  await store.upsertResource({
    type: 'mcp',
    url: 'http://mcp.ex',
    toolName: 'tool2',
    serviceName: 'C',
  });

  // Three entries: had the tool name been left out of the key, tool2 would
  // have replaced tool1 and this would be 2.
  assert.equal(store.resources.size, 3);

  // A lookup by (url, toolName) returns that tool's listing, not its sibling's.
  const mcp1 = await store.getResource('http://mcp.ex', 'tool1');
  assert.equal(mcp1.serviceName, 'B');
});
