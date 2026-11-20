/**
 * GET /usage must not report undefined counters when the shared store throws
 * (#705).
 *
 * getUsage wraps every counter read in getCount, which already had a fallback
 * parameter — but no call site passed it, so a dead shared store made the
 * informational usage report degrade into an object whose fields were dropped
 * by JSON serialization. The fallback is now zero, and the catalog_read counter
 * (metered by checkCatalogRead) is part of the report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { MemoryStore } from '../src/rate-limit-store.js';

const LIMITS = {
  global: { verifyRpm: 5, settleRpm: 5, settleRph: 5, settleRpd: 5, feeSpd: 1000 },
  keys: {},
};

/** A bucket store whose listed operations reject, standing in for a dead shared store. */
function failingStore(failing) {
  const healthy = new MemoryStore();
  const store = {};
  for (const op of ['get', 'increment', 'sweep']) {
    store[op] = failing.includes(op)
      ? async () => {
          throw new Error(`store ${op} unreachable`);
        }
      : healthy[op].bind(healthy);
  }
  return store;
}

test('getUsage reports zero counters, not undefined, when the store throws', async t => {
  const limiter = new RateLimiter(LIMITS, failingStore(['get']));
  t.after(() => limiter.close());
  // GET /usage is informational: a dead store must not become a 500.
  const usage = await limiter.getUsage('K');
  assert.equal(usage.verify_rpm, 0);
  assert.equal(usage.settle_rpm, 0);
  assert.equal(usage.settle_rph, 0);
  assert.equal(usage.settle_rpd, 0);
  assert.equal(usage.fee_spd, 0);
  assert.equal(usage.catalog_rpm, 0);
  assert.equal(usage.catalog_read_rpm, 0);
  for (const key of [
    'verify_rpm',
    'settle_rpm',
    'settle_rph',
    'settle_rpd',
    'fee_spd',
    'catalog_rpm',
    'catalog_read_rpm',
  ]) {
    assert.equal(typeof usage[key], 'number', `${key} must be a number, got ${usage[key]}`);
  }
  const json = JSON.stringify(usage);
  for (const key of [
    'verify_rpm',
    'settle_rpm',
    'settle_rph',
    'settle_rpd',
    'fee_spd',
    'catalog_rpm',
    'catalog_read_rpm',
  ]) {
    assert.ok(json.includes(`"${key}":`), `GET /usage must retain the ${key} counter`);
  }
});

test('getUsage reports the configured limits alongside the zeroed counters', async t => {
  const limiter = new RateLimiter(LIMITS, failingStore(['get']));
  t.after(() => limiter.close());
  const usage = await limiter.getUsage('K');
  assert.equal(usage.limits.verify_rpm, LIMITS.global.verifyRpm);
  assert.equal(usage.limits.settle_rpm, LIMITS.global.settleRpm);
  assert.equal(usage.limits.settle_rph, LIMITS.global.settleRph);
  assert.equal(usage.limits.settle_rpd, LIMITS.global.settleRpd);
  assert.equal(usage.limits.fee_spd, LIMITS.global.feeSpd);
  assert.equal(usage.limits.catalog_rpm, LIMITS.global.catalogRpm);
  assert.equal(typeof usage.limits.catalog_read_rpm, 'number');
});

test('getUsage counts catalog reads through the catalog_read meter', async t => {
  const limiter = new RateLimiter(LIMITS, new MemoryStore());
  t.after(() => limiter.close());
  await limiter.recordCatalogRead({ keyId: 'K' });
  const usage = await limiter.getUsage('K');
  assert.equal(usage.catalog_read_rpm, 1);
});
