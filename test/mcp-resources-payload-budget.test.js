import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  stringify,
  scrub,
  readResource,
  MAX_PAYLOAD_BYTES,
  MAX_DEPTH,
  TRUNCATION_MARKER,
} from '../src/mcp/resources.js';

describe('MCP resource serialization byte budget and depth limit (#695)', () => {
  test('constants MAX_PAYLOAD_BYTES and MAX_DEPTH are exported and defined', () => {
    assert.equal(typeof MAX_PAYLOAD_BYTES, 'number');
    assert.ok(MAX_PAYLOAD_BYTES > 0, 'MAX_PAYLOAD_BYTES must be positive');
    assert.equal(typeof MAX_DEPTH, 'number');
    assert.ok(MAX_DEPTH > 0 && MAX_DEPTH <= 20, 'MAX_DEPTH must be bounded');
    assert.equal(TRUNCATION_MARKER, '[truncated]');
  });

  test('stringify emits compact JSON without 2-space pretty-printing overhead', () => {
    const data = { hello: 'world', count: 42, nested: { key: 'value' } };
    const serialized = stringify(data);
    assert.ok(!serialized.includes('\n'), 'compact JSON should not contain newlines');
    assert.ok(!serialized.includes('  '), 'compact JSON should not contain 2-space indentation');
    assert.deepEqual(JSON.parse(serialized), data);
  });

  test('scrub enforces recursion depth limit on deeply nested extension objects', () => {
    // Construct an object nested 50 levels deep
    let deep = { level: 50 };
    for (let i = 49; i >= 1; i--) {
      deep = { level: i, child: deep };
    }

    let scrubbed;
    assert.doesNotThrow(() => {
      scrubbed = scrub(deep);
    }, 'scrub must not crash on deeply nested objects');

    // Walk down to MAX_DEPTH
    let cur = scrubbed;
    let depth = 0;
    while (cur && typeof cur === 'object' && cur.child) {
      cur = cur.child;
      depth++;
    }

    assert.ok(depth <= MAX_DEPTH, `recursion depth must not exceed ${MAX_DEPTH}`);
    assert.ok(
      typeof cur === 'string' && cur.includes('depth limit'),
      'leaf at depth limit should contain depth limit indicator',
    );
  });

  test('scrub handles circular references without call-stack exhaustion', () => {
    const circular = { name: 'circular' };
    circular.self = circular;

    assert.doesNotThrow(() => {
      const result = scrub(circular);
      assert.ok(result);
    });
  });

  test('stringify preserves payloads that fit within byte budget without truncation marker', () => {
    const small = {
      resources: [
        {
          url: 'https://example.com/api',
          serviceName: 'Small Service',
          description: 'A normal size resource',
        },
      ],
    };
    const out = stringify(small);
    assert.ok(Buffer.byteLength(out, 'utf8') <= MAX_PAYLOAD_BYTES);
    const parsed = JSON.parse(out);
    assert.equal(parsed._truncated, undefined);
    assert.equal(parsed.resources.length, 1);
  });

  test('stringify enforces byte budget and embeds truncation marker when exceeded', () => {
    // Generate a catalog payload exceeding 64 KiB
    const items = [];
    for (let i = 0; i < 500; i++) {
      items.push({
        url: `https://example.com/api/${i}`,
        serviceName: `Service Number ${i}`,
        description:
          `This is a long resource description to inflate the payload size for item ${i}. `.repeat(
            3,
          ),
        payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      });
    }
    const bigCatalog = { resources: items };

    const out = stringify(bigCatalog);
    const byteLength = Buffer.byteLength(out, 'utf8');

    assert.ok(
      byteLength <= MAX_PAYLOAD_BYTES,
      `output byte length (${byteLength}) must not exceed MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES})`,
    );

    const parsed = JSON.parse(out);
    assert.equal(parsed._truncated, true, 'payload must embed _truncated: true indicator');
    assert.ok(out.includes(TRUNCATION_MARKER), 'output must contain explicit [truncated] marker');
    assert.ok(parsed.resources.length > 0, 'some resources should still be preserved');
    assert.ok(parsed.resources.length < 500, 'resources array should be truncated to fit budget');
  });

  test('stringify supports custom maxBytes budget boundaries', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, text: `Item ${i}` }));
    const data = { items };

    const customBudget = 500;
    const out = stringify(data, customBudget);
    const byteLength = Buffer.byteLength(out, 'utf8');

    assert.ok(
      byteLength <= customBudget,
      `output byte length (${byteLength}) must be <= custom budget (${customBudget})`,
    );
    assert.ok(out.includes(TRUNCATION_MARKER));
    const parsed = JSON.parse(out);
    assert.equal(parsed._truncated, true);
  });

  test('readResource respects byte budget on catalog responses', async () => {
    const manyResources = Array.from({ length: 400 }, (_, i) => ({
      url: `https://example.com/r/${i}`,
      serviceName: `Service ${i}`,
      description: `Large payload description for resource ${i}`.repeat(5),
    }));

    const stubFetchDiscovery = async path => {
      if (path === '/discovery/resources') {
        return { resources: manyResources };
      }
      throw new Error(`Unexpected path ${path}`);
    };

    const res = await readResource('x402://catalog/resources', {
      fetchDiscovery: stubFetchDiscovery,
    });

    assert.ok(res.contents && res.contents.length > 0);
    const content = res.contents[0];
    const byteLength = Buffer.byteLength(content.text, 'utf8');

    assert.ok(
      byteLength <= MAX_PAYLOAD_BYTES,
      `readResource content (${byteLength} bytes) must not exceed MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES})`,
    );
    assert.ok(content.text.includes(TRUNCATION_MARKER));
    const parsed = JSON.parse(content.text);
    assert.equal(parsed._truncated, true);
  });
});
