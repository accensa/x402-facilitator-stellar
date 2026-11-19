/**
 * Direct assertions on every row of the MCP injection table (#692).
 *
 * `INJECTION_PATTERNS` in `src/mcp/security.js` is the table behind every
 * validated tool call, but no test imported it: the existing suite covers
 * `src/mcp/sanitize.js` and tool business behaviour. A pattern edited to a
 * regex that no longer matches its own example, or broadened until it rejects
 * ordinary prose, would not fail anything.
 *
 * The cases below are derived from the exported table rather than duplicated
 * from it: the test's covered keys must equal `INJECTION_PATTERNS`' keys, so a
 * new row fails until it gets both a rejecting and a benign sample. Each
 * rejection is checked on `payload.injectionType`, never on the message alone,
 * and every walk asserts the nested field path that raised it.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  INJECTION_PATTERNS,
  validateAgainstInjection,
  validateObjectAgainstInjection,
} from '../src/mcp/security.js';
import { McpInputError } from '../src/mcp/sanitize.js';

/**
 * One rejecting and one benign sample per exported pattern. Benign siblings
 * deliberately avoid the metacharacters and command words the
 * `commandInjection` row matches, and avoid a `select … from` shape, so no
 * accidental false positive is encoded as expected behaviour.
 */
const CASES = {
  pathTraversal: {
    rejecting: '../../etc/passwd',
    benign: 'catalog entries near the weather section',
  },
  sqlInjection: {
    rejecting: 'SELECT * FROM users',
    benign: 'Find the cheapest weather API in the catalog',
  },
  scriptInjection: {
    rejecting: '<script>alert(1)</script>',
    benign: 'Quarterly revenue report for the sales team',
  },
  commandInjection: {
    rejecting: 'curl http://evil.example',
    benign: 'Find a weather forecast for London',
  },
};

/**
 * Long, punctuation-heavy prose that is emphatically not an injection. It has
 * no shell metacharacters (`; & | ` $ ( ) { } [ ] < >`), no shell command
 * words, and no `select … from` shape — the punctuation is ordinary English.
 */
const LONG_BENIGN_PROSE =
  'The catalog lists many sellers: weather, maps, translation, and currency data — ' +
  'all with clear pricing, sensible limits, and honest descriptions! Please summarise ' +
  'the options, then compare their prices, delivery times, and support quality.';

const INJECTION_TYPES = Object.keys(INJECTION_PATTERNS);

/**
 * Runs `fn` and returns the thrown error, asserting it is an McpInputError with
 * the expected injection type and field path.
 */
function assertRejected(fn, { injectionType, field }) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof McpInputError, 'rejection must be an McpInputError');
  assert.equal(caught.isToolError, true, 'rejection must carry isToolError');
  assert.equal(caught.payload?.code, 'invalid_input', 'payload.code must be invalid_input');
  assert.equal(caught.payload?.injectionType, injectionType, 'payload.injectionType');
  assert.equal(caught.payload?.field, field, 'payload.field must name the offending path');
  assert.match(caught.message, new RegExp(injectionType), 'message names the injection type');
  return caught;
}

describe('INJECTION_PATTERNS coverage table (#692)', () => {
  test('every exported pattern has a rejecting and a benign sample', () => {
    assert.deepEqual(
      Object.keys(CASES).sort(),
      [...INJECTION_TYPES].sort(),
      'a new pattern must ship both samples before this test can pass',
    );
  });

  test('each pattern matches its rejecting sample and not its benign sibling', () => {
    for (const type of INJECTION_TYPES) {
      const pattern = INJECTION_PATTERNS[type];
      const { rejecting, benign } = CASES[type];
      assert.ok(pattern instanceof RegExp, `${type} must be a RegExp`);
      assert.match(rejecting, pattern, `${type} must match its rejecting sample`);
      assert.doesNotMatch(benign, pattern, `${type} must not match its benign sample`);
    }
  });
});

describe('validateAgainstInjection (#692)', () => {
  for (const type of INJECTION_TYPES) {
    test(`${type}: rejects its sample with injectionType "${type}"`, () => {
      assertRejected(() => validateAgainstInjection(CASES[type].rejecting, 'query'), {
        injectionType: type,
        field: 'query',
      });
    });

    test(`${type}: accepts its benign sibling`, () => {
      assert.doesNotThrow(() => validateAgainstInjection(CASES[type].benign, 'query'));
    });
  }

  test('accepts long punctuation-heavy prose that is not an injection', () => {
    assert.doesNotThrow(() => validateAgainstInjection(LONG_BENIGN_PROSE, 'description'));
    assert.doesNotThrow(() =>
      validateObjectAgainstInjection({ description: LONG_BENIGN_PROSE, limit: 10 }),
    );
  });

  test('skips non-strings instead of coercing them', () => {
    for (const value of [42, 0, -1, NaN, true, false, null, undefined, {}, ['SELECT * FROM x']]) {
      assert.doesNotThrow(
        () => validateAgainstInjection(value, 'value'),
        `non-string ${String(value)} must be skipped`,
      );
    }
  });
});

describe('validateObjectAgainstInjection (#692)', () => {
  test('reports the nested array path of a rejecting value', () => {
    assertRejected(
      () =>
        validateObjectAgainstInjection({
          tool: { args: ['safe', 'SELECT * FROM users'] },
        }),
      { injectionType: 'sqlInjection', field: 'tool.args.1' },
    );
  });

  test('reports a nested object path with the caller prefix', () => {
    assertRejected(
      () => validateObjectAgainstInjection({ request: { path: '../../etc/shadow' } }, 'params'),
      { injectionType: 'pathTraversal', field: 'params.request.path' },
    );
  });

  test('walks every string value and rejects the first offending one', () => {
    const type = 'scriptInjection';
    assertRejected(
      () =>
        validateObjectAgainstInjection({
          first: 'ordinary text',
          nested: { list: ['also ordinary', CASES[type].rejecting] },
        }),
      { injectionType: type, field: 'nested.list.1' },
    );
  });

  test('accepts objects whose leaves are all benign or non-string', () => {
    assert.doesNotThrow(() =>
      validateObjectAgainstInjection({
        query: 'weather forecast',
        limit: 10,
        cursor: null,
        flags: { exact: true, fallback: false },
        codes: [1, 2, 3],
      }),
    );
  });

  test('a number and a null in the walk are skipped, not coerced', () => {
    const walked = { count: 42, nested: { empty: null, text: 'safe' } };
    assert.doesNotThrow(() => validateObjectAgainstInjection(walked));

    // String(42) and String(null) are harmless, but a coercing validator would
    // also coerce an object's toString() output; prove the walk only visits
    // strings by handing it values whose string form looks like an injection.
    assert.doesNotThrow(() =>
      validateObjectAgainstInjection({
        count: 42,
        empty: null,
        suspicious: { toString: () => 'SELECT * FROM users' },
      }),
    );
  });

  test('returns quietly for non-objects', () => {
    for (const value of [null, undefined, 42, 'string', true]) {
      assert.doesNotThrow(() => validateObjectAgainstInjection(value));
    }
  });
});
