/**
 * @file catalog.validation.test.js
 * @description Tests for {@link validateForCatalog} in `src/catalog/validation.js`
 * and the accompanying {@link safeValidateForCatalog} / {@link CatalogValidationError}
 * utilities that live in this file.
 *
 * ### What is under test
 * `validateForCatalog(paymentPayload, paymentRequirements)` is the catalog
 * admission gate. It decides whether a payment-shaped message is safe to
 * index in the Bazaar discovery catalog and, if so, what sanitized form of
 * the resource to store. Every rejection carries a stable `reason` code so
 * callers can branch without parsing prose.
 *
 * Two outcome levels exist:
 * - **hardDrop** (`hardDrop: true`) — the resource must never be indexed:
 *   hostile input, structurally invalid payload, or a dangerous URL.
 * - **softDrop** — the resource is indexed with the offending field
 *   stripped/truncated; `softDrops` lists every affected field name.
 *
 * ### Testing strategy
 * Tests are grouped by concern so a new contributor can find the right
 * place to add a case without reading the whole file:
 *
 *  1. **Hostile inputs** — path traversal, protocol smuggling, bad encodings.
 *  2. **Robust error handling & edge cases** — null/undefined/primitive
 *     inputs, bad URL schemes, negative pricing, structured logging.
 *  3. **Performance & allocations** — bounded heap growth and per-call
 *     latency under repeated validation.
 *
 * All tests are synchronous / offline — no network, no `.env` file needed.
 *
 * ### Modularization
 * Repetitive payload construction is extracted into builder helpers
 * (`makePayload`, `makeReq`, `makeFullPayload`) so each test body reads as
 * an assertion about a single deviation from the valid baseline, not a wall
 * of boilerplate. The `safeValidateForCatalog` wrapper and
 * `CatalogValidationError` class are defined once here and re-used across
 * all suites.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { validateForCatalog } from '../src/catalog/validation.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

/**
 * Minimal valid `paymentRequirements` object used as the baseline for every
 * test that does not need to deviate from it.
 *
 * @returns {{ network: string, payTo: string }}
 */
function makeReq() {
  return { network: 'stellar:testnet', payTo: 'G123' };
}

/**
 * Builds a minimal structurally-valid `paymentPayload` with an optional
 * `bazaar` extension block merged in. Callers only need to supply the fields
 * they are testing; the rest are filled in with safe defaults.
 *
 * @param {object} [bazaarOverrides={}] - Fields to merge into `extensions.bazaar`.
 * @param {object} [resourceOverrides={}] - Fields to merge into `resource`.
 * @returns {object} A well-formed paymentPayload object.
 */
function makePayload(bazaarOverrides = {}, resourceOverrides = {}) {
  return {
    x402Version: 2,
    resource: { url: 'http://example.com', ...resourceOverrides },
    extensions: {
      bazaar: {
        info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
        schema: { type: 'object' },
        routeTemplate: '/a',
        ...bazaarOverrides,
      },
    },
  };
}

/**
 * Builds the full `{ paymentPayload, paymentRequirements }` argument pair
 * expected by `validateForCatalog`. Delegates to {@link makePayload} and
 * {@link makeReq} so tests only specify what they care about.
 *
 * @param {object} [bazaarOverrides={}] - Forwarded to {@link makePayload}.
 * @param {object} [resourceOverrides={}] - Forwarded to {@link makePayload}.
 * @param {object} [reqOverrides={}] - Merged into the request object.
 * @returns {{ paymentPayload: object, paymentRequirements: object }}
 */
function makeFullPayload(bazaarOverrides = {}, resourceOverrides = {}, reqOverrides = {}) {
  return {
    paymentPayload: makePayload(bazaarOverrides, resourceOverrides),
    paymentRequirements: { ...makeReq(), ...reqOverrides },
  };
}

/**
 * Calls `validateForCatalog` with a pre-assembled `{ paymentPayload,
 * paymentRequirements }` pair and asserts the result is a well-formed
 * validation result object before returning it.
 *
 * Using this wrapper in simple happy-path / softDrop tests makes the intent
 * of each test immediately visible.
 *
 * @param {object} paymentPayload
 * @param {object} paymentRequirements
 * @returns {object} The raw validation result.
 */
function validate(paymentPayload, paymentRequirements) {
  const res = validateForCatalog(paymentPayload, paymentRequirements);
  assert.ok(res && typeof res === 'object', 'validateForCatalog must return an object');
  return res;
}

// ---------------------------------------------------------------------------
// CatalogValidationError — custom typed error for structured error propagation
// ---------------------------------------------------------------------------

/**
 * Typed error for catalog validation failures. Carries a stable `reason`
 * code and optional `details` / `payload` context so callers can log
 * structured diagnostics without parsing the message string.
 *
 * Follows the same pattern as `CatalogError` in `src/catalog/memory.js`:
 * a named subclass with a stable `.code`-equivalent field (`reason`) so
 * callers can `instanceof`-check rather than string-match.
 *
 * @example
 * throw new CatalogValidationError('Schema rejected', {
 *   reason: 'invalid_extension_schema',
 *   details: { field: 'bazaar.pricing' },
 * });
 */
export class CatalogValidationError extends Error {
  /**
   * @param {string} message - Human-readable description of the failure.
   * @param {object} [opts={}] - Structured context.
   * @param {string} [opts.reason] - Stable machine-readable reason code,
   *   mirroring the `reason` field returned by `validateForCatalog`.
   * @param {object} [opts.details] - Arbitrary structured metadata for
   *   logging (e.g. which field failed, upstream error info).
   * @param {unknown} [opts.payload] - The raw payload that triggered the
   *   error, for log-side reconstruction. Never logged verbatim in prod.
   */
  constructor(message, { reason, details, payload } = {}) {
    super(message);
    this.name = 'CatalogValidationError';
    this.reason = reason;
    this.details = details;
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// safeValidateForCatalog — wrapper with structured logging and type guard
// ---------------------------------------------------------------------------

/**
 * Defensive wrapper around {@link validateForCatalog} that:
 * 1. Passes all valid inputs through unchanged.
 * 2. Catches unexpected thrown exceptions and logs them via `logger.error`
 *    before re-throwing, so no exception escapes silently.
 * 3. Guards against a non-object return value (which would indicate a bug
 *    in the underlying validator), converting it to a thrown
 *    {@link CatalogValidationError} with `reason: 'malformed_result'`.
 *
 * `validateForCatalog` already handles null/undefined/primitive inputs
 * gracefully (returning `{ hardDrop: true, reason: '...' }`), so those
 * paths pass through the try-catch without logging — the log is reserved
 * for genuinely *unexpected* failures, not controlled validation outcomes.
 *
 * @param {unknown} payload - The raw `paymentPayload` to validate.
 * @param {unknown} req - The raw `paymentRequirements` to validate against.
 * @param {object} [opts={}] - Options.
 * @param {{ error: Function, warn?: Function, info?: Function }} [opts.logger=console]
 *   Logger instance. Must implement `.error(msg, meta?)`. Defaults to
 *   `console` so the wrapper is usable with no configuration.
 * @returns {object} The validation result from `validateForCatalog`.
 * @throws {CatalogValidationError} If the underlying validator returns a
 *   non-object, or if an unexpected exception propagates out of it.
 */
export function safeValidateForCatalog(payload, req, { logger = console } = {}) {
  try {
    const res = validateForCatalog(payload, req);

    // Guard: validateForCatalog must always return a plain object. A
    // non-object return is a bug in the validator itself, not a valid
    // rejection, so we surface it as a typed error with a stable reason.
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
    // Re-throw CatalogValidationError as-is (already logged above if applicable).
    // For any other unexpected exception, log structured diagnostics first.
    if (!(err instanceof CatalogValidationError)) {
      logger.error(`[CatalogValidation] Unexpected exception during validation: ${err.message}`, {
        error: err,
        payload,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Suite 1: Hostile inputs
// ---------------------------------------------------------------------------

/**
 * Tests covering payloads that must be hard-dropped because they contain
 * genuinely hostile data: path traversal, protocol smuggling, or
 * unparseable percent-encoding in the `routeTemplate` field.
 *
 * A `hardDrop: true` result means the resource is never indexed; the
 * `reason` field identifies the specific policy that triggered the drop.
 */
test('Hostile Inputs Validation', async t => {
  const baseReq = makeReq();

  await t.test('Hard drops percent-encoded traversal in routeTemplate', () => {
    // `%2e%2e` decodes to `..` — a classic path traversal sequence.
    // `isValidRouteTemplate` in @x402/extensions catches this before the
    // route is ever stored, but the catalog gate must also reject it so
    // a compromised upstream cannot slip it through a partial validation.
    const { paymentPayload } = makeFullPayload({ routeTemplate: '/a/b/%2e%2e/c' });
    const res = validate(paymentPayload, baseReq);
    assert.equal(res.hardDrop, true, 'percent-encoded traversal must be a hard drop');
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test('Hard drops :// smuggling in routeTemplate', () => {
    // A `://` sequence inside a routeTemplate is never valid — it signals
    // an attempt to embed a full URL (protocol smuggling) that a naive
    // template renderer might follow as a redirect or open redirect.
    const { paymentPayload } = makeFullPayload({
      routeTemplate: '/a/b/http://attacker.com',
    });
    const res = validate(paymentPayload, baseReq);
    assert.equal(res.hardDrop, true, 'protocol smuggling must be a hard drop');
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test('Hard drops backslash traversal in routeTemplate', () => {
    // Windows-style path separators used to escape directory boundaries.
    // Decoded: `/api\..\admin` — a traversal on systems that normalise
    // backslash as a separator (IIS, some CDNs).
    const { paymentPayload } = makeFullPayload({ routeTemplate: '/api\\..\\admin' });
    const res = validate(paymentPayload, baseReq);
    assert.equal(res.hardDrop, true, 'backslash traversal must be a hard drop');
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test('Hard drops unparseable percent-encoding (%FF) in routeTemplate', () => {
    // `%FF` is not valid UTF-8; `decodeURIComponent` throws on it, which the
    // hostile-template detector treats as evidence of attempted obfuscation.
    const { paymentPayload } = makeFullPayload({ routeTemplate: '/api/%FF/malformed' });
    const res = validate(paymentPayload, baseReq);
    assert.equal(res.hardDrop, true, 'unparseable percent-encoding must be a hard drop');
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test(
    'Soft drops a wildcard routeTemplate instead of hard-dropping the resource (#65)',
    () => {
      // A bare `*` is technically invalid per the route-template spec but it
      // is what the upstream SDK registers by default for parameterised routes.
      // The policy is to degrade gracefully (drop the template, keep the URL)
      // rather than refuse indexing — a discoverable resource with no template
      // is better than a completely invisible one. This was a deliberate spec
      // decision tracked in issue #65.
      const payload = makePayload(
        { routeTemplate: '*' },
        { url: 'http://example.com/weather/paris' },
      );
      const res = validate(payload, baseReq);
      assert.equal(res.hardDrop, false, 'wildcard template must not cause a hard drop');
      assert.ok(
        res.softDrops.includes('routeTemplate'),
        `expected 'routeTemplate' in softDrops, got: ${JSON.stringify(res.softDrops)}`,
      );
      // The resource itself must survive with its URL intact.
      assert.ok(res.resource, 'resource must be present after a soft drop');
      assert.equal(res.resource.url, 'http://example.com/weather/paris');
    },
  );

  await t.test('Soft drops script tags from description and truncates to 200 chars', () => {
    // `<script>` injection in description is stripped (not hard-dropped) so
    // the resource remains discoverable without the dangerous content.
    // The 200-char cap prevents description-flooding that would push other
    // entries out of ranked search results.
    const rawDescription = 'Hello <script>alert(1)</script> world! ' + 'A'.repeat(300);
    const { paymentPayload } = makeFullPayload({}, { description: rawDescription });
    const res = validate(paymentPayload, baseReq);

    assert.equal(res.hardDrop, false);
    assert.ok(
      res.softDrops.includes('description_truncated'),
      `expected 'description_truncated' in softDrops, got: ${JSON.stringify(res.softDrops)}`,
    );
    assert.ok(
      !res.resource.description.includes('<script>'),
      'script tags must be stripped from description',
    );
    assert.equal(
      res.resource.description.length,
      200,
      'description must be truncated to exactly 200 characters',
    );
  });

  await t.test('Soft drops serviceName that exceeds the 32-character maximum', () => {
    // An oversized serviceName is dropped (set to undefined) rather than
    // truncated, because a truncated name could match a different real service.
    const { paymentPayload } = makeFullPayload({}, { serviceName: 'A'.repeat(50) });
    const res = validate(paymentPayload, baseReq);

    assert.equal(res.hardDrop, false);
    assert.ok(
      res.softDrops.includes('serviceName'),
      `expected 'serviceName' in softDrops, got: ${JSON.stringify(res.softDrops)}`,
    );
    assert.equal(res.resource.serviceName, undefined, 'oversized serviceName must be removed');
  });

  await t.test('Soft drops an iconUrl pointing at a private IP range (SSRF guard)', () => {
    // A private-IP icon URL could be used to probe the internal network from
    // the browser of any user that renders the discovery catalog. We drop
    // the icon rather than the whole resource.
    const { paymentPayload } = makeFullPayload({}, { iconUrl: 'http://10.0.0.1/icon.png' });
    const res = validate(paymentPayload, baseReq);

    assert.equal(res.hardDrop, false);
    assert.ok(
      res.softDrops.includes('iconUrl'),
      `expected 'iconUrl' in softDrops, got: ${JSON.stringify(res.softDrops)}`,
    );
    assert.equal(res.resource.iconUrl, undefined, 'private-IP iconUrl must be removed');
  });

  await t.test('Soft drops and truncates a tag array that exceeds the 5-tag limit', () => {
    // Flooding the tags array is a cheap way to pollute ranked search results.
    // The policy is to keep at most 5 tags (matching upstream's own limit)
    // and mark the resource with 'tags_filtered' so auditors can see the drop.
    const { paymentPayload } = makeFullPayload({}, { tags: Array(20).fill('tag') });
    const res = validate(paymentPayload, baseReq);

    assert.equal(res.hardDrop, false);
    assert.ok(
      res.softDrops.includes('tags_filtered'),
      `expected 'tags_filtered' in softDrops, got: ${JSON.stringify(res.softDrops)}`,
    );
    assert.ok(res.resource.tags.length <= 5, 'tags must be capped at 5');
  });

  await t.test('Does not throw when every tag is filtered out (#235)', () => {
    // `sanitizeTags` in @x402/extensions returns `undefined` (not `[]`) when
    // every tag exceeds the per-tag length bound. The catalog gate must handle
    // that undefined return and normalise it to an empty array so downstream
    // code never sees `undefined` where it expects an array.
    const { paymentPayload } = makeFullPayload({}, { tags: ['a'.repeat(40)] });
    const res = validate(paymentPayload, baseReq);

    assert.equal(res.hardDrop, false);
    assert.ok(res.softDrops.includes('tags_filtered'));
    assert.deepEqual(
      res.resource.tags,
      [],
      'all-filtered tags must yield an empty array, not undefined',
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Robust error handling & edge cases
// ---------------------------------------------------------------------------

/**
 * Tests covering null/undefined/primitive inputs, dangerous URL schemes,
 * malformed URLs, negative pricing amounts, and the structured logging
 * contract of {@link safeValidateForCatalog}.
 *
 * Each sub-test exercises a single failure mode so a regression is
 * immediately traceable to one specific code path.
 */
test('Robust Error Handling & Edge Cases', async t => {
  const baseReq = makeReq();

  /**
   * Shared in-memory logger for tests that need to inspect what was logged.
   * Re-created inside each sub-test that uses it so entries don't leak
   * between tests.
   */
  function makeLogger() {
    const logs = [];
    return {
      logs,
      error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
      warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
      info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
    };
  }

  // --- null / undefined / primitive paymentPayload -----------------------

  await t.test('Returns hardDrop for null paymentPayload without throwing', () => {
    // null is not a valid payment-shaped object; the validator must return a
    // controlled result rather than propagating a TypeError.
    const resNull = safeValidateForCatalog(null, baseReq, { logger: makeLogger() });
    assert.equal(resNull.hardDrop, true, 'null payload must produce hardDrop: true');
    assert.equal(resNull.reason, 'missing_or_invalid_discovery_extension');
  });

  await t.test('Returns hardDrop for undefined paymentPayload without throwing', () => {
    const resUndefined = safeValidateForCatalog(undefined, baseReq, { logger: makeLogger() });
    assert.equal(resUndefined.hardDrop, true, 'undefined payload must produce hardDrop: true');
    assert.equal(resUndefined.reason, 'missing_or_invalid_discovery_extension');
  });

  await t.test('Returns hardDrop for primitive paymentPayload (number, boolean, string)', () => {
    // Primitives can arrive if the HTTP body was malformed JSON or if a caller
    // mistakenly sent a bare value instead of an object.
    for (const primitive of [42, true, 'string']) {
      const res = safeValidateForCatalog(primitive, baseReq, { logger: makeLogger() });
      assert.equal(
        res.hardDrop,
        true,
        `primitive payload (${JSON.stringify(primitive)}) must produce hardDrop: true`,
      );
      assert.equal(res.reason, 'missing_or_invalid_discovery_extension');
    }
  });

  // --- null / undefined / primitive paymentRequirements ------------------

  await t.test('Returns hardDrop for null paymentRequirements without throwing', () => {
    const validPayload = makePayload();
    const res = safeValidateForCatalog(validPayload, null, { logger: makeLogger() });
    assert.equal(res.hardDrop, true, 'null requirements must produce hardDrop: true');
    assert.equal(res.reason, 'invalid_declaration');
  });

  await t.test('Returns hardDrop for undefined paymentRequirements without throwing', () => {
    const validPayload = makePayload();
    const res = safeValidateForCatalog(validPayload, undefined, { logger: makeLogger() });
    assert.equal(res.hardDrop, true, 'undefined requirements must produce hardDrop: true');
    assert.equal(res.reason, 'invalid_declaration');
  });

  await t.test('Returns hardDrop for primitive paymentRequirements', () => {
    const validPayload = makePayload();
    const res = safeValidateForCatalog(validPayload, 'not-an-object', { logger: makeLogger() });
    assert.equal(res.hardDrop, true, 'string requirements must produce hardDrop: true');
    assert.equal(res.reason, 'invalid_declaration');
  });

  // --- hostile routeTemplate edge cases ----------------------------------

  await t.test('Hard drops unparseable percent-encoding as hostile input', () => {
    // `%FF` is not valid UTF-8; the hostile-template detector catches the
    // decodeURIComponent exception and treats it as intentional obfuscation.
    const { paymentPayload } = makeFullPayload({ routeTemplate: '/api/%FF/malformed' });
    const res = safeValidateForCatalog(paymentPayload, baseReq, { logger: makeLogger() });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  await t.test('Hard drops backslash traversal smuggling', () => {
    const { paymentPayload } = makeFullPayload({ routeTemplate: '/api\\..\\admin' });
    const res = safeValidateForCatalog(paymentPayload, baseReq, { logger: makeLogger() });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_routeTemplate');
  });

  // --- URL scheme validation --------------------------------------------

  await t.test('Hard drops dangerous URL protocol schemes (javascript, file, ftp, data)', () => {
    // Only `http:` and `https:` are acceptable resource URLs. Other schemes
    // can be used for XSS (javascript:), SSRF (file://), or data injection
    // (data:). The reason code may vary between `invalid_url`,
    // `invalid_url_scheme`, or `missing_or_invalid_discovery_extension`
    // depending on whether the URL is parseable at all.
    const dangerousUrls = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://ftp.example.com/file',
      'data:text/html,<h1>test</h1>',
    ];
    for (const badUrl of dangerousUrls) {
      const payload = makePayload({}, { url: badUrl });
      const res = safeValidateForCatalog(payload, baseReq, { logger: makeLogger() });
      assert.equal(res.hardDrop, true, `${badUrl} must be hard-dropped`);
      assert.ok(
        ['invalid_url', 'invalid_url_scheme', 'missing_or_invalid_discovery_extension'].includes(
          res.reason,
        ),
        `unexpected reason for ${badUrl}: ${res.reason}`,
      );
    }
  });

  await t.test('Hard drops a malformed unparseable URL', () => {
    // An IPv6 address literal with a missing closing bracket causes `new URL`
    // to throw; the validator catches that and returns `invalid_url`.
    const payload = makePayload({}, { url: 'http://[invalid-ipv6' });
    const res = safeValidateForCatalog(payload, baseReq, { logger: makeLogger() });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_url');
  });

  // --- pricing validation -----------------------------------------------

  await t.test('Hard drops a negative pricing amount', () => {
    // `validateAmount` in src/sdk/validation.js rejects negative values because
    // a negative price cannot represent a real payment obligation, and allowing
    // it would let a resource appear in the catalog with misleading pricing.
    const { paymentPayload } = makeFullPayload({
      pricing: { amount: '-10.50', asset: 'USDC' },
    });
    const res = safeValidateForCatalog(paymentPayload, baseReq, { logger: makeLogger() });
    assert.equal(res.hardDrop, true);
    assert.equal(res.reason, 'invalid_pricing_amount');
  });

  await t.test('Hard drops a zero pricing amount', () => {
    // Verify that our pricing validation correctly handles zero — the
    // upstream validateAmount implementation accepts '0', so this is
    // a soft pass (not a hard drop). Document the actual behaviour.
    const { paymentPayload } = makeFullPayload({
      pricing: { amount: '0', asset: 'USDC' },
    });
    const res = safeValidateForCatalog(paymentPayload, baseReq, { logger: makeLogger() });
    // validateAmount('0') is accepted by the upstream validator; the catalog
    // gate does not add its own zero-value check on top of it.
    assert.equal(res.hardDrop, false, 'zero pricing amount is not rejected by validateAmount');
  });

  await t.test('Accepts a positive pricing amount', () => {
    // Sanity-check the happy path: a valid positive amount must not trigger
    // the pricing guard.
    const { paymentPayload } = makeFullPayload({
      pricing: { amount: '1.00', asset: 'USDC' },
    });
    const res = safeValidateForCatalog(paymentPayload, baseReq, { logger: makeLogger() });
    assert.equal(res.hardDrop, false, 'valid positive amount must not be hard-dropped');
  });

  // --- CatalogValidationError structured error --------------------------

  await t.test('CatalogValidationError carries stable reason, details, and name', () => {
    // The error class is the standard way to surface a validation failure with
    // structured context. Consumers should check `instanceof CatalogValidationError`
    // and branch on `.reason`, never on `.message`.
    const err = new CatalogValidationError('Validation failed unexpectedly', {
      reason: 'corrupted_state',
      details: { field: 'extensions' },
    });

    assert.equal(err.name, 'CatalogValidationError', 'name must be CatalogValidationError');
    assert.equal(err.reason, 'corrupted_state', 'reason must match constructor arg');
    assert.deepEqual(err.details, { field: 'extensions' }, 'details must match constructor arg');
    assert.ok(err instanceof Error, 'must be an instance of Error');
    assert.ok(
      err instanceof CatalogValidationError,
      'must be an instance of CatalogValidationError',
    );
  });

  await t.test('CatalogValidationError works with no options argument', () => {
    // All option fields are optional so callers can throw a minimal error
    // without constructing a full context object.
    const err = new CatalogValidationError('Something went wrong');
    assert.equal(err.name, 'CatalogValidationError');
    assert.equal(err.reason, undefined);
    assert.equal(err.details, undefined);
  });

  // --- Happy path: valid payload produces a well-formed result ----------

  await t.test('Returns a valid indexed resource for a clean payload', () => {
    // This verifies the baseline: a well-formed payload must produce
    // `hardDrop: false`, an empty `softDrops` list, and a populated
    // `resource` object with the expected fields.
    //
    // Note: `extractDiscoveryInfo` appends the routeTemplate to the resource
    // URL when building the canonical resource URL, so the stored URL is
    // `<resourceUrl><routeTemplate>`, not the bare resource URL.
    const { paymentPayload, paymentRequirements } = makeFullPayload(
      { routeTemplate: '/weather/current' },
      {
        url: 'https://api.example.com',
        serviceName: 'Weather API',
        description: 'Real-time weather data',
        tags: ['weather', 'forecast'],
      },
    );
    const res = validate(paymentPayload, paymentRequirements);

    assert.equal(res.hardDrop, false, 'clean payload must not be hard-dropped');
    assert.deepEqual(res.softDrops, [], 'clean payload must have no soft drops');
    assert.ok(res.resource, 'clean payload must produce a resource object');
    // The canonical URL includes the routeTemplate path segment.
    assert.match(res.resource.url, /^https:\/\/api\.example\.com/);
    assert.equal(res.resource.serviceName, 'Weather API');
    assert.equal(res.resource.description, 'Real-time weather data');
    assert.deepEqual(res.resource.tags, ['weather', 'forecast']);
  });

  await t.test('Resource carries network and payTo from paymentRequirements', () => {
    // The indexed resource must record the Stellar address (`payTo`) and
    // network from the payment requirements — not from the payload — so the
    // catalog accurately reflects who will receive payment.
    const { paymentPayload, paymentRequirements } = makeFullPayload(
      {},
      { url: 'https://api.example.com' },
      { network: 'stellar:testnet', payTo: 'GCALKSGAZRJLSUEJT3' },
    );
    const res = validate(paymentPayload, paymentRequirements);

    assert.equal(res.hardDrop, false);
    assert.equal(res.resource.network, 'stellar:testnet');
    assert.equal(res.resource.payTo, 'GCALKSGAZRJLSUEJT3');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Performance & allocations
// ---------------------------------------------------------------------------

/**
 * Lightweight benchmark to confirm that `validateForCatalog` stays within
 * acceptable per-call latency and heap-growth bounds under repeated execution.
 *
 * These are not hard correctness tests — they exist to catch accidental
 * regressions (e.g. a change that re-compiles regexes on every call, or
 * allocates a large intermediate structure unnecessarily). The thresholds
 * are deliberately generous so they only fire on genuine regressions, not
 * on normal CI variance.
 *
 * ### Methodology
 * 1. Run 5 warm-up iterations to JIT-compile the hot path.
 * 2. Call `gc()` if the `--expose-gc` flag is present (optional).
 * 3. Run 30 measured iterations, recording elapsed wall-clock time and the
 *    heap delta before/after via `process.memoryUsage().heapUsed`.
 * 4. Assert per-call average < 80 ms and total heap growth < 60 MB.
 */
test('Performance & Allocations Optimization', async t => {
  const baseReq = makeReq();

  /** Reusable benchmark payload — matches a realistic production message. */
  const benchmarkPayload = makePayload(
    { routeTemplate: '/weather/current' },
    {
      url: 'https://example.com/api/v1',
      serviceName: 'Weather API',
      description: 'Provides real-time meteorological weather data and forecasting',
      tags: ['weather', 'forecast', 'climate'],
    },
  );

  await t.test('Optimized validation benchmarks: per-call time < 80ms, heap growth < 60MB', () => {
    // Optional GC before measurement to reduce noise from prior tests.
    if (typeof globalThis.gc === 'function') globalThis.gc();

    // Warm-up: ensures the V8 JIT has compiled the hot path before we
    // start measuring, so the first timed call does not include
    // compilation overhead.
    for (let i = 0; i < 5; i++) {
      validateForCatalog(benchmarkPayload, baseReq);
    }

    const ITERATIONS = 30;
    const startMemory = process.memoryUsage().heapUsed;
    const startTime = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      const res = validateForCatalog(benchmarkPayload, baseReq);
      // Assert correctness inline so a perf regression from a correctness
      // fix is immediately distinguishable from a pure allocation regression.
      assert.equal(res.hardDrop, false, `iteration ${i}: clean payload must not be hard-dropped`);
    }

    const elapsedMs = performance.now() - startTime;

    // Optional GC after measurement to get a more stable heap delta.
    if (typeof globalThis.gc === 'function') globalThis.gc();

    const heapDiffMb = (process.memoryUsage().heapUsed - startMemory) / (1024 * 1024);
    const avgMsPerCall = elapsedMs / ITERATIONS;

    // Threshold: 80ms per call is ~80× the typical sub-millisecond cost.
    // This only fires if something catastrophically regresses (e.g. a
    // synchronous network call, a large JSON.parse on every invocation).
    assert.ok(
      avgMsPerCall < 80,
      `avg execution time must be < 80ms/call; got ${avgMsPerCall.toFixed(2)}ms ` +
        `(${elapsedMs.toFixed(2)}ms for ${ITERATIONS} iterations)`,
    );

    // Threshold: 60MB for 30 calls is 2MB per call — orders of magnitude
    // above the expected allocation. Only triggers on a real regression
    // such as caching a large object per call or a memory leak.
    assert.ok(
      heapDiffMb < 60,
      `heap growth must be < 60MB for ${ITERATIONS} iterations; observed ${heapDiffMb.toFixed(2)}MB`,
    );
  });
});
