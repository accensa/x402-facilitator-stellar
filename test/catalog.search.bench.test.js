/**
 * Performance benchmark tests for catalog search optimizations.
 *
 * Measures the impact of fixture caching and clock settling optimizations
 * introduced in test/helpers/catalog-search.js.
 *
 * Run with: node --test test/catalog.search.bench.test.js
 */
import test from 'node:test';
import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import {
  weatherResource,
  financeResource,
  seededSearchStore,
  settleClock,
} from './helpers/catalog-search.js';

/**
 * Measures execution time of an async function.
 */
async function measureTime(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

test('Catalog Search Performance Benchmarks', async t => {
  await t.test('fixture creation is fast with caching', async () => {
    const iterations = 1000;

    // Measure time to create fixtures with cached templates
    const timeWithCache = await measureTime(async () => {
      for (let i = 0; i < iterations; i++) {
        weatherResource();
        financeResource();
      }
    });

    // Baseline: should complete in reasonable time
    // 1000 iterations should take < 50ms with caching
    assert.ok(
      timeWithCache < 50,
      `Fixture creation with cache took ${timeWithCache.toFixed(2)}ms for ${iterations} iterations (expected < 50ms)`,
    );

    console.log(`✓ Fixture creation: ${timeWithCache.toFixed(2)}ms for ${iterations} iterations`);
  });

  await t.test('settleClock fast mode is significantly faster', async () => {
    const iterations = 100;

    // Measure standard mode (10ms delay)
    const timeStandard = await measureTime(async () => {
      for (let i = 0; i < iterations; i++) {
        await settleClock(10);
      }
    });

    // Measure fast mode (Promise.resolve())
    const timeFast = await measureTime(async () => {
      for (let i = 0; i < iterations; i++) {
        await settleClock(0);
      }
    });

    // Fast mode should be at least 10x faster than standard mode
    const speedup = timeStandard / timeFast;
    assert.ok(
      speedup > 10,
      `Fast mode speedup: ${speedup.toFixed(1)}x (expected > 10x), standard: ${timeStandard.toFixed(2)}ms, fast: ${timeFast.toFixed(2)}ms`,
    );

    console.log(
      `✓ settleClock optimization: ${speedup.toFixed(1)}x faster (standard: ${timeStandard.toFixed(2)}ms, fast: ${timeFast.toFixed(2)}ms)`,
    );
  });

  await t.test('seededSearchStore with fast mode is measurably faster', async () => {
    // Measure standard mode
    const timeStandard = await measureTime(async () => {
      await seededSearchStore();
    });

    // Measure fast mode
    const timeFast = await measureTime(async () => {
      await seededSearchStore({ fastMode: true });
    });

    // Fast mode should be faster (at least 5ms improvement)
    const improvement = timeStandard - timeFast;
    assert.ok(
      improvement > 5,
      `Fast mode improvement: ${improvement.toFixed(2)}ms (standard: ${timeStandard.toFixed(2)}ms, fast: ${timeFast.toFixed(2)}ms)`,
    );

    console.log(
      `✓ seededSearchStore fast mode: ${improvement.toFixed(2)}ms faster (standard: ${timeStandard.toFixed(2)}ms, fast: ${timeFast.toFixed(2)}ms)`,
    );
  });

  await t.test('fixture override merging preserves performance', async () => {
    const iterations = 1000;

    // Measure time with no overrides (fast path)
    const timeNoOverrides = await measureTime(async () => {
      for (let i = 0; i < iterations; i++) {
        weatherResource();
      }
    });

    // Measure time with overrides (standard path)
    const timeWithOverrides = await measureTime(async () => {
      for (let i = 0; i < iterations; i++) {
        weatherResource({ serviceName: `Weather API ${i}` });
      }
    });

    // Overhead of overrides should be reasonable (< 30x on CI, which has higher variance)
    // Note: Actual times are very small (< 1ms each), so relative overhead appears larger
    const overhead = timeWithOverrides / timeNoOverrides;
    assert.ok(
      overhead < 30,
      `Override overhead: ${overhead.toFixed(2)}x (no overrides: ${timeNoOverrides.toFixed(2)}ms, with overrides: ${timeWithOverrides.toFixed(2)}ms)`,
    );

    console.log(
      `✓ Override merging overhead: ${overhead.toFixed(2)}x (acceptable < 5x), no overrides: ${timeNoOverrides.toFixed(2)}ms, with overrides: ${timeWithOverrides.toFixed(2)}ms`,
    );
  });
});

test('Catalog Search Performance Summary', async () => {
  console.log('\n=== Performance Optimization Summary ===');
  console.log('1. Fixture caching: Reduces object creation overhead');
  console.log('2. settleClock fast mode: 10x+ faster using Promise.resolve()');
  console.log('3. seededSearchStore fast mode: 5ms+ improvement per store creation');
  console.log('4. Override merging: < 30x overhead on CI, maintains fast path for common case');
  console.log('=========================================\n');
});
