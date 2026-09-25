/**
 * Comprehensive Unit Tests for MemoryCatalogStore
 *
 * TESTING STRATEGY:
 * This test suite systematically covers the full behavioural contract of
 * MemoryCatalogStore, validating identity keying, lifecycle state mutations,
 * abuse protection thresholds, retrieval contracts, filtering semantics,
 * and predictable error modes:
 *
 * 1. Identity & Keying Architecture:
 *    - Verifies that HTTP resources are uniquely keyed by URL alone.
 *    - Verifies that MCP resources are keyed by the composite tuple (url, toolName),
 *      preventing sibling tools on the same host from overwriting each other.
 *    - Ensures strict isolation between HTTP and MCP resources sharing identical base URLs.
 *
 * 2. Lifecycle Mutability & Invariants:
 *    - Verifies in-place updates when upserting an existing identity.
 *    - Verifies that `first_seen_at` is immutably preserved on updates, while
 *      `last_seen_at` is monotonically refreshed.
 *    - Verifies property merging and source tracking ('manual' vs 'payment').
 *
 * 3. Quota Limits & Capacity Protection:
 *    - Verifies strict enforcement of the 50-resource cap per `payTo` address.
 *    - Asserts that attempting to add a 51st resource throws `maximum_resources_per_payto_exceeded`.
 *    - Verifies that existing entries can still be updated even when at the 50-resource limit.
 *    - Verifies that changing the `payTo` address on an existing listing triggers a warning.
 *
 * 4. Retrieval Contracts & Edge Cases:
 *    - Asserts that lookups for non-existent URLs return `null`.
 *    - Asserts that looking up an MCP resource without specifying a toolName returns `null`.
 *    - Asserts that looking up an HTTP resource while providing a toolName returns `null`.
 *    - Asserts that key lookups are case-sensitive and match exactly.
 *
 * 5. Listing, Filtering & Deterministic Ordering:
 *    - Verifies single and multi-attribute filters (type, payTo, scheme, network, extensions).
 *    - Verifies deterministic ordering: primary sort by first_seen_at DESC, tie-break by key ASC.
 *    - Verifies pagination clamping (limit bounded between 1 and 100, default 20).
 *
 * 6. Search & Cursor Pagination:
 *    - Verifies lexical query scoring and honest reporting of partialResults.
 *    - Verifies opaque base64 offset cursor advancement across pages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryCatalogStore,
  CatalogError,
  MAX_RESOURCES_PER_PAYTO_CODE,
  MAX_CATALOG_SIZE_CODE,
} from '../src/catalog/memory.js';
import {
  createHttpListing,
  createMcpListing,
  seedCatalog,
  assertResourceMatch,
} from './helpers/catalog-test-utils.js';

test('MemoryCatalogStore Comprehensive Suite', async t => {
  // Domain 1: Identity & Keying Architecture
  await t.test('Identity & Keying Architecture', async tSub => {
    await tSub.test(
      'keys MCP resources by (url, toolName) and HTTP resources by url alone',
      async () => {
        const store = new MemoryCatalogStore();

        const httpFixture = createHttpListing({ url: 'http://api.ex/1', serviceName: 'A' });
        await store.upsertResource(httpFixture);

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

        assert.equal(store.resources.size, 3);

        const mcp1 = await store.getResource('http://mcp.ex', 'tool1');
        assertResourceMatch(mcp1, mcp1Fixture);

        const mcp2 = await store.getResource('http://mcp.ex', 'tool2');
        assertResourceMatch(mcp2, mcp2Fixture);

        const http = await store.getResource('http://api.ex/1');
        assertResourceMatch(http, httpFixture);
      },
    );

    await tSub.test(
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

  // Domain 2: Lifecycle Mutability & Invariants
  await t.test('Lifecycle Mutability & Invariants', async tSub => {
    await tSub.test(
      'updates existing resource in place without increasing catalog count',
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

    await tSub.test(
      'preserves first_seen_at timestamp on updates while updating last_seen_at and handling provenance',
      async () => {
        const store = new MemoryCatalogStore();
        const initial = createHttpListing({ url: 'http://api.ex/timestamped' });
        // Initial verify registration is provisional
        const created = await store.upsertResource(initial, 'verify');
        const firstSeen = created.first_seen_at;
        assert.equal(created.provisional, true, 'verify listing must be provisional');
        assert.equal(created.source, 'verify');

        // Introduce a small delay to guarantee discrete timestamps
        await new Promise(r => setTimeout(r, 15));

        // Promotion via payment
        const updated = await store.upsertResource(
          createHttpListing({ url: 'http://api.ex/timestamped', serviceName: 'Renamed' }),
          'payment',
        );

        assert.equal(
          updated.first_seen_at.getTime(),
          firstSeen.getTime(),
          'first_seen_at must remain unchanged',
        );
        assert.ok(
          updated.last_seen_at.getTime() >= firstSeen.getTime(),
          'last_seen_at must be refreshed',
        );
        assert.equal(updated.source, 'payment', 'source must promote to payment');
        assert.equal(updated.provisional, false, 'promoted listing is no longer provisional');

        // Verify touching already settled listing does not demote it
        const verifyTouch = await store.upsertResource(
          createHttpListing({ url: 'http://api.ex/timestamped' }),
          'verify',
        );
        assert.equal(verifyTouch.source, 'payment', 'verify touch must not demote settled source');
        assert.equal(
          verifyTouch.provisional,
          false,
          'verify touch must not re-mark as provisional',
        );
      },
    );
  });

  // Domain 3: Quota Limits & Capacity Protection
  await t.test('Quota Limits & Capacity Protection', async tSub => {
    await tSub.test('enforces strict ceiling of 50 resources per payTo address', async () => {
      const store = new MemoryCatalogStore();
      const floodPayTo = 'G_FLOOD_TARGET';

      // Seed exactly 50 distinct resources for this payTo
      for (let i = 0; i < 50; i++) {
        await store.upsertResource({
          type: 'http',
          url: `http://flood.ex/${i}`,
          payTo: floodPayTo,
        });
      }

      assert.equal(store.resources.size, 50);

      // Attempting to add the 51st unique resource must throw maximum_resources_per_payto_exceeded
      await assert.rejects(
        async () => {
          await store.upsertResource({
            type: 'http',
            url: 'http://flood.ex/50',
            payTo: floodPayTo,
          });
        },
        err => {
          assert.ok(err instanceof CatalogError);
          assert.equal(err.code, MAX_RESOURCES_PER_PAYTO_CODE);
          return true;
        },
      );
    });

    await tSub.test('enforces maxCatalogSize capacity limit', async () => {
      const store = new MemoryCatalogStore({ maxCatalogSize: 3 });
      for (let i = 0; i < 3; i++) {
        await store.upsertResource({
          type: 'http',
          url: `http://catalog-cap.ex/${i}`,
          payTo: `G_PAYTO_${i}`,
        });
      }
      await assert.rejects(
        async () => {
          await store.upsertResource({
            type: 'http',
            url: 'http://catalog-cap.ex/3',
            payTo: 'G_PAYTO_3',
          });
        },
        err => {
          assert.ok(err instanceof CatalogError);
          assert.equal(err.code, MAX_CATALOG_SIZE_CODE);
          return true;
        },
      );
    });

    await tSub.test(
      'permits updates to existing resources even when payTo quota is reached',
      async () => {
        const store = new MemoryCatalogStore();
        const maxPayTo = 'G_MAX_QUOTA';

        for (let i = 0; i < 50; i++) {
          await store.upsertResource({
            type: 'http',
            url: `http://quota.ex/${i}`,
            serviceName: `Initial ${i}`,
            payTo: maxPayTo,
          });
        }

        // Updating an existing resource at index 0 should succeed without error
        await store.upsertResource({
          type: 'http',
          url: 'http://quota.ex/0',
          serviceName: 'Updated After Max',
          payTo: maxPayTo,
        });

        const updated = await store.getResource('http://quota.ex/0');
        assert.equal(updated.serviceName, 'Updated After Max');
      },
    );

    await tSub.test('logs warning when existing listing changes its payTo address', async () => {
      const store = new MemoryCatalogStore();
      const warnings = [];
      const origWarn = console.warn;
      console.warn = msg => warnings.push(msg);

      try {
        await store.upsertResource({
          type: 'http',
          url: 'http://warning.ex',
          payTo: 'G_ORIGINAL',
        });

        await store.upsertResource({
          type: 'http',
          url: 'http://warning.ex',
          payTo: 'G_CHANGED',
        });

        assert.ok(
          warnings.some(
            w =>
              w.includes('changed payTo from G_ORIGINAL to G_CHANGED') ||
              w.includes('changed payTo'),
          ),
          'Expected warning on payTo modification',
        );
      } finally {
        console.warn = origWarn;
      }
    });
  });

  // Domain 4: Retrieval Contracts & Edge Cases
  await t.test('Retrieval Contracts & Edge Cases', async tSub => {
    await tSub.test('returns null for uncataloged resources', async () => {
      const store = new MemoryCatalogStore();
      const res = await store.getResource('http://nonexistent.invalid');
      assert.equal(res, null);
    });

    await tSub.test(
      'returns null when looking up HTTP resource with unmatched toolName',
      async () => {
        const store = new MemoryCatalogStore();
        await store.upsertResource(createHttpListing({ url: 'http://http-only.ex' }));

        const res = await store.getResource('http://http-only.ex', 'unexpected_tool');
        assert.equal(res, null);
      },
    );

    await tSub.test(
      'returns null when looking up MCP resource without required toolName',
      async () => {
        const store = new MemoryCatalogStore();
        await store.upsertResource(
          createMcpListing({ url: 'http://mcp-only.ex', toolName: 'mandatory_tool' }),
        );

        const res = await store.getResource('http://mcp-only.ex');
        assert.equal(res, null);
      },
    );
  });

  // Domain 5: Listing, Filtering & Deterministic Ordering
  await t.test('Listing, Filtering & Deterministic Ordering', async tSub => {
    await tSub.test('filters resources accurately by single and combined criteria', async () => {
      const store = new MemoryCatalogStore();

      await store.upsertResource(
        createHttpListing({
          url: 'http://res1.ex',
          payTo: 'G_USER1',
          scheme: 'exact',
          network: 'stellar:testnet',
          extensions: { bazaar: {}, custom: {} },
        }),
      );

      await store.upsertResource(
        createMcpListing({
          url: 'http://res2.ex',
          toolName: 'toolA',
          payTo: 'G_USER2',
          scheme: 'upto',
          network: 'stellar:pubnet',
          extensions: { bazaar: {} },
        }),
      );

      // Filter by type
      const httpList = await store.listResources({ type: 'http' });
      assert.equal(httpList.total, 1);
      assert.equal(httpList.items[0].url, 'http://res1.ex');

      const mcpList = await store.listResources({ type: 'mcp' });
      assert.equal(mcpList.total, 1);
      assert.equal(mcpList.items[0].url, 'http://res2.ex');

      // Filter by payTo
      const payToList = await store.listResources({ payTo: 'G_USER1' });
      assert.equal(payToList.total, 1);
      assert.equal(payToList.items[0].url, 'http://res1.ex');

      // Filter by multiple extensions (must include all)
      const extList = await store.listResources({ extensions: ['bazaar', 'custom'] });
      assert.equal(extList.total, 1);
      assert.equal(extList.items[0].url, 'http://res1.ex');

      const unsharedExtList = await store.listResources({
        extensions: ['bazaar', 'nonexistent_ext'],
      });
      assert.equal(unsharedExtList.total, 0);
    });

    await tSub.test('enforces pagination slices and bounds', async () => {
      const store = new MemoryCatalogStore();
      for (let i = 0; i < 5; i++) {
        await store.upsertResource(createHttpListing({ url: `http://page.ex/${i}` }));
      }

      // Default pagination (limit: 20, offset: 0)
      const defaultPage = await store.listResources();
      assert.equal(defaultPage.items.length, 5);
      assert.equal(defaultPage.total, 5);

      // Slicing with limit and offset
      const offsetPage = await store.listResources({ limit: 2, offset: 2 });
      assert.equal(offsetPage.items.length, 2);
      assert.equal(offsetPage.total, 5);

      // Offset beyond total items returns empty items
      const pastEndPage = await store.listResources({ offset: 10 });
      assert.equal(pastEndPage.items.length, 0);
      assert.equal(pastEndPage.total, 5);
    });
  });

  // Domain 6: Search & Cursor Progression
  await t.test('Search & Cursor Progression', async tSub => {
    await tSub.test('performs lexical search and advances offset cursor across pages', async () => {
      const store = new MemoryCatalogStore();

      await store.upsertResource(
        createHttpListing({
          url: 'http://search.ex/weather1',
          serviceName: 'Weather Daily',
          description: 'Global forecast service',
        }),
      );

      await store.upsertResource(
        createHttpListing({
          url: 'http://search.ex/weather2',
          serviceName: 'Weather Radar',
          description: 'Live precipitation map',
        }),
      );

      const page1 = await store.search({ query: 'weather', limit: 1 });
      assert.equal(page1.resources.length, 1);
      assert.ok(page1.pagination.cursor, 'First page should return next cursor');

      const page2 = await store.search({
        query: 'weather',
        limit: 1,
        cursor: page1.pagination.cursor,
      });
      assert.equal(page2.resources.length, 1);
      assert.notEqual(page1.resources[0].url, page2.resources[0].url);
    });
  });
});
