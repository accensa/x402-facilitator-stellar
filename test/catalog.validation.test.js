import test from 'node:test';
import assert from 'node:assert/strict';
import { validateForCatalog } from '../src/catalog/validation.js';

test('Hostile Inputs Validation', async t => {
  const baseReq = { network: 'stellar:testnet', payTo: 'G123' };

  await t.test('Hard drops percent-encoded traversal in routeTemplate', () => {
    // Upstream isValidRouteTemplate catches this
    const payload = {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a/b/%2e%2e/c', // percent-encoded traversal
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test('Hard drops :// smuggling in routeTemplate', () => {
    const payload = {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a/b/http://attacker.com',
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test('Soft drops a wildcard routeTemplate instead of dropping the resource (#65)', () => {
    // This is what upstream's own SDK registers by default for a wildcard
    // route, and it warns about the degraded metadata rather than refusing
    // to send it. It must not vanish from discovery.
    const payload = {
      x402Version: 2,
      resource: { url: 'http://example.com/weather/paris' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '*',
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.hardDrop, false);
    assert.ok(res.softDrops.includes('routeTemplate'));
    assert.ok(res.resource);
    assert.equal(res.resource.url, 'http://example.com/weather/paris');
  });

  await t.test('Drops a description containing markup rather than stripping it (#217)', () => {
    const payload = {
      x402Version: 2,
      resource: {
        url: 'http://example.com',
        description: 'Hello <script>alert(1)</script> world!',
      },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.hardDrop, false);
    assert.ok(res.softDrops.includes('description'));
    // Refused, not rewritten: nothing is stored for a consumer to render.
    assert.equal(res.resource.description, undefined);
  });

  await t.test('Drops entity-encoded markup too, which the old regex let through (#217)', () => {
    for (const description of [
      'Click &lt;script&gt;alert(1)&lt;/script&gt; now',
      'ends with a tag </div>',
      '<!-- comment -->hidden',
      '&#60;script&#62;',
      '&#x3c;script&#x3e;',
    ]) {
      const payload = {
        x402Version: 2,
        resource: { url: 'http://example.com', description },
        extensions: {
          bazaar: {
            info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
            schema: { type: 'object' },
            routeTemplate: '/a',
          },
        },
      };
      const res = validateForCatalog(payload, baseReq);
      assert.ok(
        res.softDrops.includes('description'),
        `expected ${JSON.stringify(description)} to be refused`,
      );
      assert.equal(res.resource.description, undefined);
    }
  });

  await t.test('Keeps angle brackets that cannot begin markup (#217)', () => {
    const description = 'Flat rates < 5% per call and > 99.9% uptime';
    const payload = {
      x402Version: 2,
      resource: { url: 'http://example.com', description },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.resource.description, description);
    assert.deepEqual(res.softDrops, []);
    assert.deepEqual(res.truncations, []);
  });

  await t.test(
    'Reports a shortened description as a truncation, not a dropped field (#219)',
    () => {
      const payload = {
        x402Version: 2,
        resource: {
          url: 'http://example.com',
          description: 'A'.repeat(300),
        },
        extensions: {
          bazaar: {
            info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
            schema: { type: 'object' },
            routeTemplate: '/a',
          },
        },
      };
      const res = validateForCatalog(payload, baseReq);
      assert.equal(res.hardDrop, false);
      assert.equal(res.resource.description.length, 200);
      assert.ok(res.truncations.includes('description'));
      // The field is present and shortened. Reporting it as dropped told the
      // caller a field had vanished, and leaked 'description_truncated' as if it
      // were a field name.
      assert.deepEqual(res.softDrops, []);
      assert.ok(!res.softDrops.includes('description_truncated'));
    },
  );

  await t.test(
    'A refused description cannot sneak back in via the discovery extension (#217)',
    () => {
      // extractDiscoveryInfo populates `description` from resource.description, so
      // refusing the caller's value has to delete the extracted copy too —
      // otherwise the refused text is stored by the line that reads it.
      const payload = {
        x402Version: 2,
        resource: { url: 'http://example.com', description: '<img src=x onerror=alert(1)>' },
        extensions: {
          bazaar: {
            info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
            schema: { type: 'object' },
            routeTemplate: '/a',
          },
        },
      };
      const res = validateForCatalog(payload, baseReq);
      assert.ok(res.softDrops.includes('description'));
      assert.equal(res.resource.description, undefined);
      assert.ok(!JSON.stringify(res.resource).includes('onerror'));
    },
  );

  await t.test('Soft drops oversized fields', () => {
    const payload = {
      x402Version: 2,
      resource: {
        url: 'http://example.com',
        serviceName: 'A'.repeat(50), // > 32 max
      },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.hardDrop, false);
    assert.ok(res.softDrops.includes('serviceName'));
    assert.equal(res.resource.serviceName, undefined);
  });

  await t.test('Soft drops an iconUrl pointing at a private IP range', () => {
    const payload = {
      x402Version: 2,
      resource: {
        url: 'http://example.com',
        iconUrl: 'http://10.0.0.1/icon.png',
      },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.hardDrop, false);
    assert.ok(res.softDrops.includes('iconUrl'));
    assert.equal(res.resource.iconUrl, undefined);
  });

  await t.test('Filters tag flooding', () => {
    const payload = {
      x402Version: 2,
      resource: {
        url: 'http://example.com',
        tags: Array(20).fill('tag'), // Upstream limits to 5 usually
      },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.hardDrop, false);
    assert.ok(res.softDrops.includes('tags_filtered'));
    assert.ok(res.resource.tags.length <= 5);
  });

  await t.test('Does not throw when every tag is filtered out (#235)', () => {
    const payload = {
      x402Version: 2,
      resource: {
        url: 'http://example.com',
        tags: ['a'.repeat(40)], // exceeds upstream's per-tag length bound
      },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/a',
        },
      },
    };
    const res = validateForCatalog(payload, baseReq);
    assert.equal(res.hardDrop, false);
    assert.ok(res.softDrops.includes('tags_filtered'));
    assert.deepEqual(res.resource.tags, []);
  });
});
