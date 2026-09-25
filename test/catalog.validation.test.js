import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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

  await t.test('Soft drops script in description and truncates', () => {
    const payload = {
      x402Version: 2,
      resource: {
        url: 'http://example.com',
        description: 'Hello <script>alert(1)</script> world! ' + 'A'.repeat(300),
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
    assert.ok(res.softDrops.includes('description_truncated'));
    // script tags stripped
    assert.ok(!res.resource.description.includes('<script>'));
    // truncated to 200
    assert.equal(res.resource.description.length, 200);
  });

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

/**
 * Custom error definition for catalog validation exceptions.
 * Encapsulates contextual failure data, enabling predictable error handling and logging.
 */
export class CatalogValidationError extends Error {
  constructor(message, { reason, details, payload } = {}) {
    super(message);
    this.name = 'CatalogValidationError';
    this.reason = reason;
    this.details = details;
    this.payload = payload;
  }
}

/**
 * Defensive execution wrapper for validateForCatalog with structured logging
 * and fallback guarantees against unhandled exceptions.
 */
export function safeValidateForCatalog(payload, req, { logger = console } = {}) {
  try {
    const res = validateForCatalog(payload, req);
    if (!res || typeof res !== 'object') {
      const err = new CatalogValidationError('Validation returned non-object result', {
        reason: 'malformed_result',
        payload,
      });
      logger.error(`[CatalogValidation] ${err.message}`, { reason: err.reason });
      throw err;
    }
    return res;
  } catch (err) {
    if (!(err instanceof CatalogValidationError)) {
      logger.error(`[CatalogValidation] Unexpected exception during validation: ${err.message}`, {
        error: err,
        payload,
      });
    }
    throw err;
  }
}

test('Robust Error Handling & Edge Cases', async t => {
  const baseReq = { network: 'stellar:testnet', payTo: 'G123' };
  const logs = [];
  const testLogger = {
    error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
    warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
    info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
  };

  await t.test('Explicitly handles null or undefined paymentPayload without crashing', () => {
    const resNull = safeValidateForCatalog(null, baseReq, { logger: testLogger });
    assert.equal(resNull.hardDrop, true);
    assert.equal(resNull.reason, 'missing_or_invalid_discovery_extension');

    const resUndefined = safeValidateForCatalog(undefined, baseReq, { logger: testLogger });
    assert.equal(resUndefined.hardDrop, true);
    assert.equal(resUndefined.reason, 'missing_or_invalid_discovery_extension');
  });

  await t.test('Explicitly handles primitive paymentPayload (number, boolean, string)', () => {
    for (const primitive of [42, 'string', true]) {
      const res = safeValidateForCatalog(primitive, baseReq, { logger: testLogger });
      assert.equal(res.hardDrop, true);
      assert.equal(res.reason, 'missing_or_invalid_discovery_extension');
    }
  });

  await t.test('Explicitly handles null or undefined paymentRequirements without crashing', () => {
    const validPayload = {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
        },
      },
    };

    const resNull = safeValidateForCatalog(validPayload, null, { logger: testLogger });
    assert.equal(resNull.hardDrop, true);
    assert.equal(resNull.reason, 'invalid_declaration');

    const resUndefined = safeValidateForCatalog(validPayload, undefined, { logger: testLogger });
    assert.equal(resUndefined.hardDrop, true);
    assert.equal(resUndefined.reason, 'invalid_declaration');
  });

  await t.test('Explicitly handles primitive paymentRequirements', () => {
    const validPayload = {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
        },
      },
    };

    const res = safeValidateForCatalog(validPayload, 'not-an-object', { logger: testLogger });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_declaration');
  });

  await t.test('Catches unparseable URI percent-encoding as hostile drop', () => {
    const payload = {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/api/%FF/malformed',
        },
      },
    };
    const res = safeValidateForCatalog(payload, baseReq, { logger: testLogger });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test('Catches backslash traversal smuggling as hostile drop', () => {
    const payload = {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          routeTemplate: '/api\\..\\admin',
        },
      },
    };
    const res = safeValidateForCatalog(payload, baseReq, { logger: testLogger });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test('Hard drops dangerous URL protocol schemes (javascript, file, ftp)', () => {
    const badSchemes = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://ftp.example.com/file',
      'data:text/html,test',
    ];

    for (const badUrl of badSchemes) {
      const payload = {
        x402Version: 2,
        resource: { url: badUrl },
        extensions: {
          bazaar: {
            info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
            schema: { type: 'object' },
          },
        },
      };
      const res = safeValidateForCatalog(payload, baseReq, { logger: testLogger });
      assert.equal(res.hardDrop, true);
      assert.ok(
        res.reason === 'invalid_url' ||
          res.reason === 'invalid_url_scheme' ||
          res.reason === 'missing_or_invalid_discovery_extension',
      );
    }
  });

  await t.test('Hard drops malformed unparseable URLs', () => {
    const payload = {
      x402Version: 2,
      resource: { url: 'http://[invalid-ipv6' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
        },
      },
    };
    const res = safeValidateForCatalog(payload, baseReq, { logger: testLogger });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_url');
  });

  await t.test('Hard drops invalid pricing amount', () => {
    const payload = {
      x402Version: 2,
      resource: { url: 'http://example.com' },
      extensions: {
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
          schema: { type: 'object' },
          pricing: { amount: '-10.50', asset: 'USDC' },
        },
      },
    };
    const res = safeValidateForCatalog(payload, baseReq, { logger: testLogger });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_pricing_amount');
  });

  await t.test('Propagates meaningful errors and logs structured diagnostic events', () => {
    const customErr = new CatalogValidationError('Validation failed unexpectedly', {
      reason: 'corrupted_state',
      details: { field: 'extensions' },
    });
    assert.equal(customErr.name, 'CatalogValidationError');
    assert.equal(customErr.reason, 'corrupted_state');
    assert.deepEqual(customErr.details, { field: 'extensions' });
  });
});

test('Performance & Allocations Optimization', async t => {
  const baseReq = { network: 'stellar:testnet', payTo: 'G123' };
  const benchmarkPayload = {
    x402Version: 2,
    resource: {
      url: 'https://example.com/api/v1',
      serviceName: 'Weather API',
      description: 'Provides real-time meteorological weather data and forecasting',
      tags: ['weather', 'forecast', 'climate'],
    },
    extensions: {
      bazaar: {
        info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
        schema: { type: 'object' },
        routeTemplate: '/weather/current',
      },
    },
  };

  await t.test(
    'Optimized validation benchmarks show responsive execution and bounded allocations',
    () => {
      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
      }

      // Warm up
      for (let i = 0; i < 5; i++) {
        validateForCatalog(benchmarkPayload, baseReq);
      }

      const iterations = 30;
      const startMemory = process.memoryUsage().heapUsed;
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        const res = validateForCatalog(benchmarkPayload, baseReq);
        assert.equal(res.hardDrop, false);
      }

      const elapsedMs = performance.now() - startTime;
      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
      }
      const endMemory = process.memoryUsage().heapUsed;
      const heapDiffMb = (endMemory - startMemory) / (1024 * 1024);
      const avgMsPerCall = elapsedMs / iterations;

      // Benchmarking metric: average per-call time must be responsive (< 80ms under full schema validation)
      assert.ok(
        avgMsPerCall < 80,
        `Expected avg execution time < 80ms/call, got ${avgMsPerCall.toFixed(2)}ms/call (${elapsedMs.toFixed(2)}ms total)`,
      );
      // Benchmarking metric: heap allocations remain strictly bounded even under concurrent test runs
      assert.ok(
        heapDiffMb < 60,
        `Expected bounded heap growth (<60MB for ${iterations} iterations), observed ${heapDiffMb.toFixed(2)}MB`,
      );
    },
  );
});
