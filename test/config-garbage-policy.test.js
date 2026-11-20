/**
 * @file config-garbage-policy.test.js
 * @description One policy for every numeric env var (#674).
 *
 * `src/config.js` used to answer the same mistake two ways: `parsePositiveInt`
 * threw at boot, while `nonNegativeInt` quietly returned the documented
 * default. So `RATE_LIMIT_VERIFY_RPM=60O` stopped the process, but
 * `DISCOVERY_CACHE_MAX_AGE_SECONDS=60O` served a 60-second cache and looked
 * deliberate. These tests pin the unified policy — a typo is a boot error
 * naming the variable, the raw value and the accepted range; an absent (or
 * blank) variable takes the default — for both helpers, through both the
 * positive variables (`PORT`, `MAX_TX_FEE_STROOPS`) and the non-negative ones
 * (`DISCOVERY_CACHE_*`).
 *
 * They fail on `main`: on `main` the `DISCOVERY_CACHE_*` garbage cases resolve
 * to the default instead of throwing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';

// A real ed25519 seed: resolveConfig validates signer secrets with a
// checksum-aware StrKey decode (#498), so an "S"-prefixed placeholder would
// fail before any numeric setting is read.
const SECRET = 'SAO2MAIQCR5T27QDICO3QJTD2YZ4PMEAVLCLQ6AANVGPCZ53TEACPDOQ';

const resolveWith = overrides => resolveConfig({ FACILITATOR_SECRET: SECRET, ...overrides });

/** Values that are not plain non-negative decimal digits. */
const GARBAGE = [
  'abc', // not a number at all
  '60O', // letter O instead of a zero — the typo from #674
  '60s', // trailing unit
  '1e2', // Number() would accept this scientific notation
  '12.5', // Number() would accept and floor this
  '-1', // negative
  '1 0', // internal space
  ' 60 ', // surrounding whitespace is not an integer either
  '   ', // whitespace-only is a typo, not an unset variable
  '0x3c', // hex
];

/**
 * Asserts that `env` stops the boot with a message naming the variable, the raw
 * value and the accepted range.
 *
 * @param {string} variable - env var name
 * @param {string} raw - the offending value
 * @param {string} range - expected `min and max` text, e.g. `0 and 9007199254740991`
 */
function assertRefusedAtBoot(variable, raw, range) {
  assert.throws(
    () => resolveWith({ [variable]: raw }),
    err => {
      assert.match(
        err.message,
        new RegExp(`${variable} must be a finite integer between ${range}, got`),
        `the error must name ${variable} and the accepted range, got: ${err.message}`,
      );
      assert.ok(
        err.message.includes(`got "${raw}".`),
        `the error must quote the raw value, got: ${err.message}`,
      );
      return true;
    },
  );
}

test('a typo in DISCOVERY_CACHE_MAX_AGE_SECONDS stops the boot (#674)', () => {
  // The headline case: this used to resolve to 60 and emit a Cache-Control
  // header nobody could tell apart from a deliberate setting.
  assertRefusedAtBoot('DISCOVERY_CACHE_MAX_AGE_SECONDS', '60O', '0 and 9007199254740991');
});

test('every non-numeric DISCOVERY_CACHE_MAX_AGE_SECONDS value is refused, not defaulted', () => {
  for (const raw of GARBAGE) {
    assertRefusedAtBoot('DISCOVERY_CACHE_MAX_AGE_SECONDS', raw, '0 and 9007199254740991');
  }
});

test('a typo in DISCOVERY_CACHE_STALE_SECONDS stops the boot, not just max-age', () => {
  for (const raw of GARBAGE) {
    assertRefusedAtBoot('DISCOVERY_CACHE_STALE_SECONDS', raw, '0 and 9007199254740991');
  }
});

test('DISCOVERY_CACHE_* takes the default when the variable is absent', () => {
  const config = resolveWith();
  assert.strictEqual(config.discoveryCache.maxAgeSeconds, 60);
  assert.strictEqual(config.discoveryCache.staleWhileRevalidateSeconds, 300);
});

test('DISCOVERY_CACHE_* takes the default when the variable is blank', () => {
  // `''` is what a `.env` file produces for a declared-but-unset variable, so
  // it is treated as absent — the same convention nonNegativeInt always had.
  const config = resolveWith({
    DISCOVERY_CACHE_MAX_AGE_SECONDS: '',
    DISCOVERY_CACHE_STALE_SECONDS: '',
  });
  assert.strictEqual(config.discoveryCache.maxAgeSeconds, 60);
  assert.strictEqual(config.discoveryCache.staleWhileRevalidateSeconds, 300);
});

test('DISCOVERY_CACHE_* still accepts 0, which disables client-side caching', () => {
  const config = resolveWith({
    DISCOVERY_CACHE_MAX_AGE_SECONDS: '0',
    DISCOVERY_CACHE_STALE_SECONDS: '0',
  });
  assert.strictEqual(config.discoveryCache.maxAgeSeconds, 0);
  assert.strictEqual(config.discoveryCache.staleWhileRevalidateSeconds, 0);
});

test('DISCOVERY_CACHE_* accepts a normal value unchanged', () => {
  const config = resolveWith({
    DISCOVERY_CACHE_MAX_AGE_SECONDS: '120',
    DISCOVERY_CACHE_STALE_SECONDS: '600',
  });
  assert.strictEqual(config.discoveryCache.maxAgeSeconds, 120);
  assert.strictEqual(config.discoveryCache.staleWhileRevalidateSeconds, 600);
});

test('out-of-range DISCOVERY_CACHE_* values are refused, naming the range', () => {
  assertRefusedAtBoot('DISCOVERY_CACHE_MAX_AGE_SECONDS', '-60', '0 and 9007199254740991');
  assertRefusedAtBoot(
    'DISCOVERY_CACHE_STALE_SECONDS',
    '99999999999999999999',
    '0 and 9007199254740991',
  );
});

test('PORT refuses the same garbage shapes, naming the variable and raw value', () => {
  for (const raw of GARBAGE) {
    assertRefusedAtBoot('PORT', raw, '1 and 65535');
  }
  assertRefusedAtBoot('PORT', '65536', '1 and 65535');
  assertRefusedAtBoot('PORT', '0', '1 and 65535');
});

test('PORT takes the default when the variable is absent', () => {
  assert.strictEqual(resolveWith().port, 3402);
});

test('MAX_TX_FEE_STROOPS refuses the same garbage shapes, naming the variable', () => {
  for (const raw of GARBAGE) {
    assertRefusedAtBoot('MAX_TX_FEE_STROOPS', raw, '100 and 10000000');
  }
  assertRefusedAtBoot('MAX_TX_FEE_STROOPS', '99', '100 and 10000000');
});

test('MAX_TX_FEE_STROOPS takes the default when the variable is absent', () => {
  const config = resolveWith();
  assert.strictEqual(config.perNetwork['stellar:testnet'].maxTransactionFeeStroops, 50000);
});

test('both helpers refuse the same garbage value with the same message shape', () => {
  // The pairs are one positive variable and one non-negative variable, so this
  // asserts the two helpers now agree on *how* they refuse, not merely that
  // they do.
  const positive = (() => {
    try {
      resolveWith({ PORT: '60O' });
    } catch (err) {
      return err.message;
    }
    throw new Error('PORT=60O did not throw');
  })();
  const nonNegative = (() => {
    try {
      resolveWith({ DISCOVERY_CACHE_MAX_AGE_SECONDS: '60O' });
    } catch (err) {
      return err.message;
    }
    throw new Error('DISCOVERY_CACHE_MAX_AGE_SECONDS=60O did not throw');
  })();

  assert.match(positive, /must be a finite integer between \d+ and \d+, got "60O"\./);
  assert.match(nonNegative, /must be a finite integer between \d+ and \d+, got "60O"\./);
});
