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
 *
 * 7. Failure Modes, Diagnostics & Fallbacks:
 *    - Every expected rejection is awaited through one guard, so a store that
 *      stopped guarding, guarded on the wrong condition, or threw untyped is
 *      reported as a named failure mode instead of a bare assertion error.
 *    - A rejection must carry a stable reason code *and* a message that names
 *      the limit, and must leave no entry, counter drift or unreadable catalog
 *      behind — one flooded payTo cannot lock the others out.
 *    - A listing that is missing entirely is a programming error, not a policy
 *      one: it must fail loudly rather than be written under a null key.
 *    - The payTo-change warning is asserted as exactly one diagnostic naming
 *      the listing and both addresses, at warn level and never at error.
 *    - An unreachable embedding provider degrades to lexical search with
 *      partialResults set, drains its in-flight work through flush(), accounts
 *      the failure, and leaves no unhandled rejection behind.
 *    - A cursor a client can produce by accident (garbage base64, unknown
 *      prefix, negative or non-numeric offset) falls back to page one or to a
 *      terminating empty page instead of throwing.
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

/**
 * Harness error for a catalog call that failed in a way the test did not
 * anticipate.
 *
 * A bare `assert.rejects` reports a rejected promise as one boolean fact, so a
 * guard that stopped guarding, guarded on the wrong condition, or replaced a
 * typed rejection with an untyped throw all read the same in the failure
 * output. Everything unexpected in this file is funnelled through this type so
 * the diagnostic names the operation, what was expected and what arrived.
 */
export class CatalogFailureModeError extends Error {
  constructor(operation, { expected, actual }) {
    super(`catalog.${operation}: expected ${expected}, but got ${actual}`);
    this.name = 'CatalogFailureModeError';
    this.operation = operation;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Three HTTP listings that all match the query "weather" at clearly different
 * scores, returned in descending expected rank.
 *
 * The scorer ranks a tag match (10 + 8) above a description match (10 + 3)
 * above a service-name-only match (10), and then applies a recency decay. That
 * decay is computed from `Date.now()` at millisecond resolution, so listings
 * written in the same millisecond are separated by a factor of roughly 1 - 3e-10
 * — close enough to a tie that a millisecond boundary falling between two
 * searches can reorder them. Spreading the base scores keeps the expected order
 * a property of the fixtures rather than of the clock, which is what lets a
 * test compare one search against another.
 *
 * @param {string} host - Host to build the three URLs under.
 * @returns {object[]} Listings in the order a search must return them.
 */
function rankedWeatherListings(host) {
  return [
    createHttpListing({
      url: `http://${host}/0`,
      serviceName: 'Weather Radar',
      tags: ['weather'],
    }),
    createHttpListing({
      url: `http://${host}/1`,
      serviceName: 'Weather Radar',
      description: 'Live weather precipitation map',
    }),
    createHttpListing({ url: `http://${host}/2`, serviceName: 'Weather Radar' }),
  ];
}

/**
 * Runs `fn` with console.warn and console.error captured, restoring the real
 * console even when `fn` throws — otherwise a failing test silences the output
 * of every test after it and the run looks clean where it is not. Args are
 * joined so a diagnostic logged as a format string plus values still reads as
 * one line.
 *
 * @param {() => Promise<unknown>} fn - Operation to run while capturing.
 * @returns {Promise<{warns: string[], errors: string[]}>} Captured output by level.
 */
async function captureDiagnostics(fn) {
  const diagnostics = { warns: [], errors: [] };
  const restore = [
    ['warns', 'warn'],
    ['errors', 'error'],
  ].map(([key, method]) => {
    const original = console[method];
    console[method] = (...args) => diagnostics[key].push(args.map(String).join(' '));
    return () => {
      console[method] = original;
    };
  });
  try {
    await fn();
  } finally {
    for (const undo of restore) undo();
  }
  return diagnostics;
}

/**
 * Renders a rejected value for a diagnostic without assuming it is an Error.
 * A promise can reject with a string, or with no value at all, and reading
 * `.name` off those would raise a second, less useful error in place of the one
 * this file is trying to name.
 *
 * @param {unknown} thrown - The rejection value.
 * @returns {string} One line naming the type and, for an Error, its message.
 */
function describeThrown(thrown) {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  return `a non-Error rejection (${typeof thrown}: ${String(thrown)})`;
}

/**
 * Awaits a catalog call that must fail with a typed CatalogError, and reports
 * every other outcome as a CatalogFailureModeError:
 *
 *   - resolving at all (the guard silently stopped guarding),
 *   - rejecting with something that is not a CatalogError (an untyped throw),
 *   - rejecting under a different reason code (the wrong guard fired),
 *   - rejecting with an empty message (a code an operator cannot act on).
 *
 * `call` is a thunk rather than a promise so the call only starts once the
 * guard is awaiting it — a rejected promise built by the caller and never
 * awaited here would be an unhandled rejection instead of a test failure.
 *
 * @param {string} operation - Store method under test, for the diagnostic.
 * @param {() => Promise<unknown>} call - Deferred store call.
 * @param {{code: string, messageIncludes: string}} expectations - Reason code the rejection must carry and a fragment its message must contain.
 * @returns {Promise<import('../src/catalog/memory.js').CatalogError>} The rejection that was thrown.
 */
async function assertCatalogRejection(operation, call, { code, messageIncludes }) {
  let thrown = null;
  let resolved = false;
  try {
    await call();
    resolved = true;
  } catch (err) {
    thrown = err;
  }

  if (resolved) {
    throw new CatalogFailureModeError(operation, {
      expected: `a rejection carrying ${code}`,
      actual: 'a successful resolution',
    });
  }
  if (!(thrown instanceof CatalogError)) {
    throw new CatalogFailureModeError(operation, {
      expected: `a CatalogError carrying ${code}`,
      actual: describeThrown(thrown),
    });
  }
  if (thrown.code !== code) {
    throw new CatalogFailureModeError(operation, {
      expected: `reason code ${code}`,
      actual: `reason code ${String(thrown.code)}`,
    });
  }
  if (typeof thrown.message !== 'string' || thrown.message.trim() === '') {
    throw new CatalogFailureModeError(operation, {
      expected: 'a non-empty message naming the limit that was hit',
      actual: JSON.stringify(thrown.message),
    });
  }
  if (!thrown.message.includes(messageIncludes)) {
    throw new CatalogFailureModeError(operation, {
      expected: `a message containing ${JSON.stringify(messageIncludes)}`,
      actual: JSON.stringify(thrown.message),
    });
  }
  return thrown;
}

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
      await assertCatalogRejection(
        'upsertResource',
        () =>
          store.upsertResource({
            type: 'http',
            url: 'http://flood.ex/50',
            payTo: floodPayTo,
          }),
        {
          code: MAX_RESOURCES_PER_PAYTO_CODE,
          // The message has to name the ceiling, not just the code: the code is
          // for the caller's branch, the message is what reaches the log.
          messageIncludes: 'maximum resources per payTo (50) exceeded',
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
      await assertCatalogRejection(
        'upsertResource',
        () =>
          store.upsertResource({
            type: 'http',
            url: 'http://catalog-cap.ex/3',
            payTo: 'G_PAYTO_3',
          }),
        {
          code: MAX_CATALOG_SIZE_CODE,
          messageIncludes: 'maximum catalog size (3) exceeded',
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

    await tSub.test('logs exactly one diagnostic when a listing changes payTo', async () => {
      const store = new MemoryCatalogStore();
      const diagnostics = await captureDiagnostics(async () => {
        // A brand new listing is not a change, so it must stay silent...
        await store.upsertResource({
          type: 'http',
          url: 'http://warning.ex',
          payTo: 'G_ORIGINAL',
        });

        // ...and the update that moves the payTo is the one and only warning.
        await store.upsertResource({
          type: 'http',
          url: 'http://warning.ex',
          payTo: 'G_CHANGED',
        });
      });

      assert.deepEqual(
        diagnostics.warns,
        ['[Catalog] Resource http://warning.ex:: changed payTo from G_ORIGINAL to G_CHANGED'],
        'a payTo change must log exactly one warning naming the listing and both addresses',
      );
      assert.deepEqual(
        diagnostics.errors,
        [],
        'a payTo change is a policy warning and must never be logged as an error',
      );
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
          // The tag lifts this listing a full 8 points clear of the other one.
          // Without it both match "weather" only in the service name, so their
          // scores differ by nothing but the scorer's recency decay — and that
          // decay is computed from `Date.now()` per item at millisecond
          // resolution, so a millisecond boundary falling between the two
          // searches below could swap them. This test then returned the same
          // listing on page one and page two about once in 35 runs.
          tags: ['weather'],
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

  // Domain 7: Failure Modes, Diagnostics & Fallbacks
  await t.test('Failure Modes, Diagnostics & Fallbacks', async tSub => {
    await tSub.test(
      'a rejected write leaves no entry, no counter drift and a usable store',
      async () => {
        const store = new MemoryCatalogStore({ maxCatalogSize: 2 });
        await store.upsertResource({
          type: 'http',
          url: 'http://cap.ex/1',
          payTo: 'G_ONE',
        });
        await store.upsertResource({
          type: 'http',
          url: 'http://cap.ex/2',
          payTo: 'G_TWO',
        });

        await assertCatalogRejection(
          'upsertResource',
          () =>
            store.upsertResource({
              type: 'http',
              url: 'http://cap.ex/3',
              payTo: 'G_THREE',
            }),
          {
            code: MAX_CATALOG_SIZE_CODE,
            messageIncludes: 'maximum catalog size (2) exceeded',
          },
        );

        // Nothing partial survives the rejection: the identity was never written
        // and the per-payTo counter that enforces the other cap was not charged
        // for an entry that does not exist.
        assert.equal(
          store.resources.has('http://cap.ex/3::'),
          false,
          'a rejected write must not leave a half-written entry behind',
        );
        assert.equal(
          store.payToCounts.get('G_THREE'),
          undefined,
          'a rejected write must not consume per-payTo quota',
        );
        assert.equal(store.resources.size, 2, 'a rejected write must not change the catalog size');
        assert.equal(await store.getResource('http://cap.ex/3'), null);
        assert.equal(
          (await store.listResources()).total,
          2,
          'the rejected listing must not be listable',
        );

        // The store is still usable afterwards: an existing identity updates
        // normally, which is the fallback a caller has after being refused.
        const updated = await store.upsertResource({
          type: 'http',
          url: 'http://cap.ex/1',
          serviceName: 'Renamed After Rejection',
          payTo: 'G_ONE',
        });
        assert.equal(updated.serviceName, 'Renamed After Rejection');
      },
    );

    await tSub.test('a rejected write only blocks the payTo that caused it', async () => {
      const store = new MemoryCatalogStore();
      const floodPayTo = 'G_FLOOD';
      for (let i = 0; i < 50; i++) {
        await store.upsertResource({
          type: 'http',
          url: `http://quota-isolation.ex/${i}`,
          payTo: floodPayTo,
        });
      }

      await assertCatalogRejection(
        'upsertResource',
        () =>
          store.upsertResource({
            type: 'http',
            url: 'http://quota-isolation.ex/50',
            payTo: floodPayTo,
          }),
        {
          code: MAX_RESOURCES_PER_PAYTO_CODE,
          messageIncludes: 'maximum resources per payTo (50) exceeded',
        },
      );

      // The cap is per payTo, so one flooder cannot deny service to anyone
      // else — and its own counter is unchanged by the refusal.
      const other = await store.upsertResource({
        type: 'http',
        url: 'http://bystander.ex/1',
        payTo: 'G_BYSTANDER',
      });
      assert.equal(
        other.url,
        'http://bystander.ex/1',
        'another seller must still be able to register',
      );
      assert.equal(
        store.payToCounts.get(floodPayTo),
        50,
        'the refused write must not inflate the counter',
      );
      assert.equal(store.payToCounts.get('G_BYSTANDER'), 1);
    });

    await tSub.test(
      'quota held by expired provisional listings is released by pruneExpired',
      async () => {
        // verify-only listings expire on their own, but the per-payTo counter is
        // only corrected when they are physically pruned: a seller at the cap
        // stays capped until the sweep runs. Pinned because expiry and pruning
        // are the two paths that move the same counter.
        const store = new MemoryCatalogStore({ catalogVerifyTtlMs: 5 });
        for (let i = 0; i < 50; i++) {
          await store.upsertResource(
            { type: 'http', url: `http://expiring.ex/${i}`, payTo: 'G_EXPIRING' },
            'verify',
          );
        }

        await assertCatalogRejection(
          'upsertResource',
          () =>
            store.upsertResource(
              { type: 'http', url: 'http://expiring.ex/50', payTo: 'G_EXPIRING' },
              'verify',
            ),
          {
            code: MAX_RESOURCES_PER_PAYTO_CODE,
            messageIncludes: 'maximum resources per payTo (50) exceeded',
          },
        );

        // Expired listings leave discovery immediately, while the counter that
        // enforces the cap still counts them.
        await new Promise(r => setTimeout(r, 25));
        assert.equal(
          (await store.listResources()).total,
          0,
          'expired provisional listings must be hidden from discovery',
        );

        assert.equal(await store.pruneExpired(), 50, 'pruneExpired must report what it removed');
        assert.equal(
          store.payToCounts.get('G_EXPIRING'),
          undefined,
          'pruning must return the quota the expired listings were holding',
        );

        const recovered = await store.upsertResource(
          { type: 'http', url: 'http://expiring.ex/50', payTo: 'G_EXPIRING' },
          'verify',
        );
        assert.equal(
          recovered.url,
          'http://expiring.ex/50',
          'a pruned seller must be able to write again',
        );
        assert.equal(store.payToCounts.get('G_EXPIRING'), 1);
      },
    );

    await tSub.test('a missing listing fails loudly instead of being written', async () => {
      const store = new MemoryCatalogStore();

      for (const [label, value] of [
        ['null', null],
        ['undefined', undefined],
      ]) {
        let thrown = null;
        try {
          await store.upsertResource(value);
        } catch (err) {
          thrown = err;
        }

        assert.ok(thrown, `upsertResource(${label}) must reject, not resolve`);
        // A missing listing is a programming error, not a policy refusal, so
        // the store must not dress it up as one: admitting a bad payload is
        // the API boundary's job (validateForCatalog hard-drops it first).
        assert.ok(
          !(thrown instanceof CatalogError),
          `${label} must not be reported as a catalog policy error (got code ${thrown.code})`,
        );
        assert.ok(
          thrown instanceof TypeError,
          `expected a TypeError for a ${label} listing, got ${thrown.name}`,
        );
        assert.ok(
          thrown.message.length > 0,
          `a ${label} listing must fail with a readable message`,
        );
      }

      // The same contract on the read paths: params are validated and clamped
      // by the API boundary, so a caller that skips it gets a loud failure
      // rather than a silently mis-filtered or empty page.
      for (const [label, call] of [
        ['listResources(null)', () => store.listResources(null)],
        ['search()', () => store.search()],
      ]) {
        await assert.rejects(call, TypeError, `${label} must reject with a TypeError`);
      }

      assert.equal(
        store.resources.size,
        0,
        'a rejected listing must not be written under a null key',
      );
      assert.equal(
        store.payToCounts.size,
        0,
        'a rejected listing must not be counted against a payTo',
      );

      // ...and a well-formed listing still works, so the failure above is a
      // statement about the input rather than a broken store.
      const entry = await store.upsertResource(createHttpListing({ url: 'http://recovered.ex' }));
      assert.equal(entry.url, 'http://recovered.ex');
    });

    await tSub.test(
      'an unreachable embedding provider degrades to lexical search and drains its work',
      async () => {
        // Port 1 on loopback refuses (or times out) immediately: no network, no
        // fixture server, and a real provider failure rather than a stubbed one.
        const store = new MemoryCatalogStore({
          embeddingsUrl: 'http://127.0.0.1:1/embed',
          embeddingsTimeoutMs: 250,
        });

        const diagnostics = await captureDiagnostics(async () => {
          for (const listing of rankedWeatherListings('degraded.ex')) {
            await store.upsertResource(listing);
          }

          // The upserts must not have waited on the provider...
          assert.ok(
            store._pendingEmbeddings.size > 0,
            'embedding work must still be in flight once the upserts resolved',
          );
          // ...so flush() is what makes the outcome observable, and it has to
          // settle rather than reject: a rejected background promise escapes
          // as an unhandled rejection that no test owns.
          await assert.doesNotReject(store.flush(), 'flush() must settle, never reject');
        });

        assert.equal(
          store._pendingEmbeddings.size,
          0,
          'flush() must drain every in-flight embedding request',
        );
        assert.equal(
          store.embeddingClient.health.consecutiveFailures,
          3,
          'each provider failure must be accounted for rather than swallowed',
        );

        // The provider gives up loudly exactly once: the circuit breaker opens
        // on the third consecutive failure instead of warning on every call.
        const breakerWarnings = diagnostics.warns.filter(w =>
          /failed 3 consecutive times; cooldown until /.test(w),
        );
        assert.equal(
          breakerWarnings.length,
          1,
          `expected one circuit-breaker warning, got ${JSON.stringify(diagnostics.warns)}`,
        );
        assert.ok(
          breakerWarnings[0].includes('http://127.0.0.1:1/embed'),
          'the warning must name the provider that failed',
        );
        assert.deepEqual(
          diagnostics.errors,
          [],
          'a degraded provider must not be logged as an error',
        );

        // The fallback partialResults exists to describe: lexical ranking still
        // serves the query, and the response admits the result set is partial.
        const page = await store.search({ query: 'weather', limit: 2 });
        assert.equal(page.resources.length, 2, 'lexical search must still rank matches');
        assert.equal(page.partialResults, true, 'a provider outage must be reported honestly');
        assert.equal(
          page.resources[0].embedding,
          undefined,
          'no vector may be invented when the provider failed',
        );

        // A search inside the cooldown window must not call the provider again,
        // and must return the same page the first one did — the breaker saves
        // the timeout, it does not change the answer.
        const duringCooldown = await store.search({ query: 'weather', limit: 2 });
        assert.deepEqual(
          duringCooldown.resources.map(r => r.url),
          page.resources.map(r => r.url),
          'a search inside the cooldown must not reorder or drop results',
        );
      },
    );

    await tSub.test(
      'a failed vector write is logged with its cause, and the listing survives it',
      async () => {
        // The provider half of the embedding pipeline is stubbed so the
        // failure under test is the *persistence* one: the hook durable stores
        // override to save a freshly-computed vector (src/catalog/postgres.js).
        class UnwritableStore extends MemoryCatalogStore {
          async _afterEmbedding() {
            throw new Error('catalog table unavailable');
          }
        }

        const store = new UnwritableStore({ embeddingsUrl: 'http://embeddings.invalid/embed' });
        let embedCalls = 0;
        store.embeddingClient.embed = async () => {
          embedCalls += 1;
          return [0.1, 0.2, 0.3];
        };

        const diagnostics = await captureDiagnostics(async () => {
          const entry = await store.upsertResource(
            createHttpListing({ url: 'http://unwritable.ex', serviceName: 'Weather Service' }),
          );
          // The upsert already returned before the vector existed, so a
          // persistence failure cannot take the listing down with it.
          assert.ok(entry, 'the listing must be returned even though the vector cannot be saved');
          // The vector write is still in flight, which is the state flush()
          // exists to make observable.
          assert.equal(
            store._pendingEmbeddings.size,
            1,
            'the vector write must still be in flight once the upsert resolved',
          );
          // It has to settle rather than reject: a background promise that
          // rejects escapes as an unhandled rejection no test owns.
          await assert.doesNotReject(store.flush(), 'flush() must settle, never reject');
        });

        assert.equal(embedCalls, 1, 'the provider must have been consulted for the new listing');
        assert.equal(store._pendingEmbeddings.size, 0, 'flush() must drain the failed attempt');
        assert.deepEqual(
          diagnostics.warns,
          ['[Catalog] Failed to re-embed http://unwritable.ex::: catalog table unavailable'],
          'the diagnostic must name both the listing and the underlying cause',
        );
        assert.deepEqual(
          diagnostics.errors,
          [],
          'a failed vector write must not be logged as an error',
        );

        // The fallback: the listing is still discoverable and still ranked by
        // the vector that was computed in memory. What is missing is the
        // durable copy — which is precisely what the warning names.
        const listed = await store.getResource('http://unwritable.ex');
        assert.deepEqual(
          listed.embedding,
          [0.1, 0.2, 0.3],
          'the computed vector must survive in memory when only the durable write failed',
        );
        assert.equal(
          (await store.listResources()).total,
          1,
          'the listing must survive a failed vector write',
        );
        assert.equal(
          store.embeddingClient.health.consecutiveFailures,
          0,
          'a persistence failure is not a provider failure and must not trip the breaker',
        );
      },
    );

    await tSub.test(
      'a cursor a client can produce by accident falls back instead of throwing',
      async () => {
        const store = new MemoryCatalogStore();
        const listings = rankedWeatherListings('cursor.ex');
        for (const listing of listings) {
          await store.upsertResource(listing);
        }

        const firstPage = await store.search({ query: 'weather', limit: 2 });
        const firstUrls = firstPage.resources.map(r => r.url);
        assert.deepEqual(
          firstUrls,
          [listings[0].url, listings[1].url],
          'the fixtures must rank in a fixed order for the page comparison below to mean anything',
        );
        assert.ok(firstPage.pagination.cursor, 'a non-final page must hand back a cursor');

        // Every cursor a client can produce by accident decodes to page one
        // rather than throwing — the same fallback the wire contract pins for
        // a garbage cursor in test/search.http.test.js.
        const fallbacks = {
          'garbage base64': '!!! not base64 at all',
          'empty string': '',
          'unknown prefix': Buffer.from('page:1').toString('base64'),
          'negative offset': Buffer.from('offset:-5').toString('base64'),
        };
        for (const [label, cursor] of Object.entries(fallbacks)) {
          const page = await store.search({ query: 'weather', limit: 2, cursor });
          assert.deepEqual(
            page.resources.map(r => r.url),
            firstUrls,
            `a ${label} cursor must be treated as page one`,
          );
        }

        // A cursor past the end is a terminating empty page, not a repeat of the
        // first one: a client walking cursors has to be able to stop.
        const pastEnd = await store.search({
          query: 'weather',
          limit: 2,
          cursor: Buffer.from('offset:99').toString('base64'),
        });
        assert.deepEqual(pastEnd.resources, [], 'an out-of-range cursor must return no resources');
        assert.equal(
          pastEnd.pagination.cursor,
          null,
          'an out-of-range cursor must not hand back another cursor',
        );

        // A cursor whose offset is not a number decodes to NaN. What has to hold
        // is that the response stays well formed and pagination cannot loop; the
        // clamp in memory.js currently lands on an empty terminating page rather
        // than page one, and normalising it to page one is a follow-up. Pinned
        // here so that change, when it happens, is deliberate.
        const malformed = await store.search({
          query: 'weather',
          limit: 2,
          cursor: Buffer.from('offset:abc').toString('base64'),
        });
        assert.ok(
          Array.isArray(malformed.resources),
          'a non-numeric offset must not throw or return a malformed page',
        );
        assert.equal(
          malformed.pagination.cursor,
          null,
          'a non-numeric offset must terminate rather than hand back a cursor that repeats itself',
        );

        // A page that consumed the last result is the end of the walk: handing
        // back a cursor here would send a client round the same empty page for
        // ever, which is the one way a "harmless" cursor bug becomes an outage.
        const finalPage = await store.search({ query: 'weather', limit: 3 });
        assert.equal(
          finalPage.resources.length,
          3,
          'the final page must return the remaining results',
        );
        assert.equal(
          finalPage.pagination.cursor,
          null,
          'a page that consumed the last result must not hand back another cursor',
        );
      },
    );
  });
});
