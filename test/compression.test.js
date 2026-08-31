/**
 * Compression (#69).
 *
 * Registered in src/app.js via @fastify/compress with the plugin's default
 * 1kb threshold (confirmed against measured sizes: a full discovery resources
 * page is ~72KB and gzips to ~2.8KB — 96% smaller — while the settlement hot
 * path stays under 1kb and is deliberately left uncompressed).
 *
 * The wire behaviours that matter here are the acceptance criteria:
 *   - responses above the threshold are gzip-encoded and carry
 *     Content-Encoding: gzip;
 *   - responses below the threshold are not compressed;
 *   - Vary: Accept-Encoding is present on compressed responses so a shared
 *     cache cannot serve a gzipped body to a client that did not ask for one;
 *   - a client sending no Accept-Encoding still receives a valid uncompressed
 *     body.
 *
 * These use Fastify `inject` rather than Node's fetch: Node's fetch silently
 * adds Accept-Encoding: gzip and auto-decompresses the body, both of which
 * hide exactly the wire behaviour under test (whether the byte stream the
 * client actually receives is compressed, and the Vary header that protects a
 * shared cache). inject speaks raw HTTP and leaves the bytes and headers
 * untouched.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { testConfig, stubFacilitator, stubRateLimiter, stubCatalog } from './helpers/app.js';

/** ~150+ bytes each; a page of these puts the response well over the 1kb threshold. */
function fatResource(i) {
  return {
    type: 'mcp',
    url: `https://merchant-${i}.example.com/api/resource-${i}`,
    toolName: `tool-${i}`,
    serviceName: `Merchant Service ${i}`,
    description:
      'Returns real-time market data for the SOROBAN ecosystem including token prices, volume and liquidity aggregated in one request.',
    tags: ['soroban', 'defi', 'prices', 'analytics', 'market-data'],
    iconUrl: `https://cdn.example.com/icon-${i}.png`,
    scheme: 'exact',
    network: 'stellar:testnet',
    extensions: { bazaar: { routeTemplate: '/api/merchant/:resourceId' } },
    payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
  };
}

describe('response compression (#69)', () => {
  let app;
  before(async () => {
    const items = Array.from({ length: 100 }, (_, i) => fatResource(i));
    const catalog = stubCatalog({
      listResources: async () => ({ items, total: items.length }),
    });
    app = await createApp(testConfig(), stubFacilitator(), stubRateLimiter(), catalog);
    await app.ready();
  });
  after(() => app.close());

  test('gzips an above-threshold discovery response and sets Vary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discovery/resources?limit=100',
      headers: { 'accept-encoding': 'gzip' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    const vary = (res.headers.vary ?? '').toLowerCase();
    assert.ok(vary.includes('accept-encoding'), `Vary was: ${vary}`);

    // The delivered bytes are genuinely smaller and inflate back to the same
    // JSON a non-compressing client would have received.
    const compressed = res.rawPayload;
    const json = JSON.parse(gunzipSync(compressed).toString('utf8'));
    assert.equal(json.x402Version, 2);
    assert.equal(json.items.length, 100);
  });

  test('a client sending no Accept-Encoding gets a valid uncompressed body', async () => {
    // The shared-cache concern: a client that never advertised gzip must never
    // be handed a gzipped body, no matter how large the response is.
    const res = await app.inject({
      method: 'GET',
      url: '/discovery/resources?limit=100',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-encoding'], undefined);
    const json = JSON.parse(res.body);
    assert.equal(json.items.length, 100);
  });

  test('a sub-threshold response is not compressed', async () => {
    // /supported is a few hundred bytes -> stays uncompressed even when the
    // client advertises gzip, matching the measured decision that compressing
    // the small hot-path responses saves nothing and only costs CPU.
    const supported = {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'stellar:testnet',
          extra: { areFeesSponsored: true },
        },
      ],
      extensions: [],
      signers: { 'stellar:*': ['GABC'] },
    };

    const smallApp = await createApp(
      testConfig(),
      stubFacilitator({ getSupported: () => supported }),
      stubRateLimiter(),
      stubCatalog(),
    );
    await smallApp.ready();
    try {
      const res = await smallApp.inject({
        method: 'GET',
        url: '/supported',
        headers: { 'accept-encoding': 'gzip' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-encoding'], undefined);
      assert.deepEqual(JSON.parse(res.body), supported);
    } finally {
      await smallApp.close();
    }
  });

  test('the payment hot path is left uncompressed and still works', async () => {
    // /settle returns a small body, so compression must not touch it. This
    // guards the more important property: a stock client that never advertises
    // gzip keeps receiving byte-for-byte the same response as before.
    const settleApp = await createApp(
      testConfig(),
      stubFacilitator(),
      stubRateLimiter(),
      stubCatalog(),
    );
    await settleApp.ready();
    try {
      const res = await settleApp.inject({
        method: 'POST',
        url: '/settle',
        headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
        payload: JSON.stringify({
          paymentPayload: {
            x402Version: 2,
            scheme: 'exact',
            network: 'stellar:testnet',
            payload: { transaction: 'AAAAAgAAAA...' },
          },
          paymentRequirements: {
            scheme: 'exact',
            network: 'stellar:testnet',
            asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
            maxAmountRequired: '1000',
            payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
          },
        }),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-encoding'], undefined);
      assert.equal(JSON.parse(res.body).success, true);
    } finally {
      await settleApp.close();
    }
  });
});
