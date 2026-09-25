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
import {
  createHttpListing,
  createMcpListing,
  seedCatalog,
  assertResourceMatch,
} from './helpers/catalog-test-utils.js';

test('catalog identity and keying architecture', async t => {
  await t.test(
    'keys MCP resources by (url, toolName) and HTTP resources by url alone',
    async () => {
      const store = new MemoryCatalogStore();

      // HTTP resource: identity is the URL alone
      const httpFixture = createHttpListing({ url: 'http://api.ex/1', serviceName: 'A' });
      await store.upsertResource(httpFixture);

      // MCP resources: same URL, different tools, so two distinct listings
      const mcp1Fixture = createMcpListing({
        url: 'http://mcp.ex',
        toolName: 'tool1',
        serviceName: 'B',
      });
      const mcp2Fixture = createMcpListing({
        url: 'http://mcp.ex',
        toolName: 'tool2',
        serviceName: 'C',
      });

      await seedCatalog(store, [mcp1Fixture, mcp2Fixture]);

      // Three entries: had the tool name been left out of the key, tool2 would
      // have replaced tool1 and this would be 2.
      assert.equal(store.resources.size, 3);

      // A lookup by (url, toolName) returns that tool's listing, not its sibling's
      const mcp1 = await store.getResource('http://mcp.ex', 'tool1');
      assertResourceMatch(mcp1, mcp1Fixture);

      const mcp2 = await store.getResource('http://mcp.ex', 'tool2');
      assertResourceMatch(mcp2, mcp2Fixture);

      const http = await store.getResource('http://api.ex/1');
      assertResourceMatch(http, httpFixture);
    },
  );

  await t.test(
    'updates existing resource in place when identical identity is upserted',
    async () => {
      const store = new MemoryCatalogStore();
      const initial = createHttpListing({
        url: 'http://api.ex/resource',
        serviceName: 'Original Service',
      });
      await store.upsertResource(initial);

      const updated = createHttpListing({
        url: 'http://api.ex/resource',
        serviceName: 'Updated Service',
      });
      await store.upsertResource(updated);

      assert.equal(store.resources.size, 1);
      const fetched = await store.getResource('http://api.ex/resource');
      assert.equal(fetched.serviceName, 'Updated Service');
    },
  );

  await t.test(
    'distinguishes between HTTP resource and MCP tool sharing identical base URL',
    async () => {
      const store = new MemoryCatalogStore();
      const sharedUrl = 'https://dual.service.example/api';

      const httpEntry = createHttpListing({ url: sharedUrl, serviceName: 'HTTP Endpoint' });
      const mcpEntry = createMcpListing({
        url: sharedUrl,
        toolName: 'mcp_tool',
        serviceName: 'MCP Endpoint',
      });

      await seedCatalog(store, [httpEntry, mcpEntry]);
      assert.equal(store.resources.size, 2);

      const fetchedHttp = await store.getResource(sharedUrl);
      const fetchedMcp = await store.getResource(sharedUrl, 'mcp_tool');

      assertResourceMatch(fetchedHttp, httpEntry);
      assertResourceMatch(fetchedMcp, mcpEntry);
    },
  );
});
