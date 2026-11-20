/**
 * @file payment-schema-bounds.test.js
 * @description Transport bounds on the payment body (#676).
 *
 * `PAYMENT_BODY_SCHEMA` used to accept any string for `scheme`/`network`, any
 * number of properties in either object, and any unknown key at the top level.
 * With a 256 KB body cap and AJV running with `removeAdditional: false`, a
 * body made only of junk keys passed validation and was handed to the scheme.
 * These tests pin the bounds — maxLength on the two transport-owned strings,
 * maxProperties on both objects, `additionalProperties: false` at the top
 * level only — and that a rejection keeps the existing 400 shapes.
 *
 * The last test proves the other side: an unknown key *inside*
 * `paymentRequirements` is still accepted, because that is where a scheme
 * carries its own extras. Rejecting it would be a conformance failure.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, testConfig, VALID_BODY } from './helpers/app.js';

const SCHEME_MAX = 32;
const NETWORK_MAX = 64;

/** The /verify rejection shape, unchanged by this hardening. */
function assertVerifyRejection(json) {
  assert.equal(json.isValid, false);
  assert.equal(json.invalidReason, 'invalid_request');
  assert.equal(typeof json.invalidMessage, 'string');
  assert.ok(json.invalidMessage.length > 0);
  assert.equal(json.stack, undefined);
  assert.doesNotMatch(json.invalidMessage, /\n\s+at /, 'no stack trace in the message');
}

/** The /settle rejection shape, unchanged by this hardening. */
function assertSettleRejection(json) {
  assert.equal(json.success, false);
  assert.equal(json.errorReason, 'invalid_request');
  assert.equal(typeof json.errorMessage, 'string');
  assert.ok(json.errorMessage.length > 0);
  assert.equal(json.transaction, '');
  assert.equal(json.stack, undefined);
  assert.doesNotMatch(json.errorMessage, /\n\s+at /, 'no stack trace in the message');
}

describe('payment body schema bounds', () => {
  test('an oversized scheme is rejected with the verify 400 shape', async () => {
    const app = await serve();
    try {
      const res = await app.post('/verify', {
        paymentPayload: VALID_BODY.paymentPayload,
        paymentRequirements: {
          ...VALID_BODY.paymentRequirements,
          scheme: 'x'.repeat(SCHEME_MAX + 1),
        },
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assertVerifyRejection(json);
      assert.match(json.invalidMessage, /scheme/);
    } finally {
      await app.close();
    }
  });

  test('an oversized network is rejected with the settle 400 shape', async () => {
    const app = await serve();
    try {
      const res = await app.post('/settle', {
        paymentPayload: VALID_BODY.paymentPayload,
        paymentRequirements: {
          ...VALID_BODY.paymentRequirements,
          network: 'x'.repeat(NETWORK_MAX + 1),
        },
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assertSettleRejection(json);
      assert.match(json.errorMessage, /network/);
    } finally {
      await app.close();
    }
  });

  test('an unknown top-level key is rejected on both routes', async () => {
    const app = await serve();
    try {
      const body = { ...VALID_BODY, anUnknownKey: { nested: true } };

      const verify = await app.post('/verify', body);
      assert.equal(verify.status, 400);
      assertVerifyRejection(await verify.json());

      const settle = await app.post('/settle', body);
      assert.equal(settle.status, 400);
      assertSettleRejection(await settle.json());
    } finally {
      await app.close();
    }
  });

  test('a top-level x402Version is accepted, because the wire format defines it', async () => {
    // VerifyRequest in @x402/core carries x402Version beside the two objects,
    // so it is a known key, not an unknown one. Rejecting it would break
    // clients that send the spec's own envelope.
    const app = await serve();
    try {
      for (const x402Version of [1, 2]) {
        const res = await app.post('/verify', { ...VALID_BODY, x402Version });
        assert.equal(res.status, 200, `x402Version ${x402Version} was rejected`);
      }
    } finally {
      await app.close();
    }
  });

  test('a body of nothing but unknown keys is rejected, not passed to the scheme', async () => {
    // The shape that motivated the bound: 256 KB of keys the transport does
    // not own. It must fail validation rather than reach the facilitator.
    const app = await serve();
    try {
      const junk = {};
      for (let i = 0; i < 50; i += 1) junk[`unknown_${i}`] = { pad: 'x'.repeat(64) };
      const res = await app.post('/verify', { ...VALID_BODY, ...junk });
      assert.equal(res.status, 400);
      assertVerifyRejection(await res.json());
    } finally {
      await app.close();
    }
  });

  test('paymentPayload and paymentRequirements are bounded by maxProperties', async () => {
    const app = await serve();
    try {
      const payload = { ...VALID_BODY.paymentPayload };
      for (let i = 0; i < 20; i += 1) payload[`extra_${i}`] = i;

      const payloadRes = await app.post('/verify', {
        paymentPayload: payload,
        paymentRequirements: VALID_BODY.paymentRequirements,
      });
      assert.equal(payloadRes.status, 400);
      assertVerifyRejection(await payloadRes.json());

      const requirements = { ...VALID_BODY.paymentRequirements };
      for (let i = 0; i < 40; i += 1) requirements[`extra_${i}`] = i;

      const requirementsRes = await app.post('/verify', {
        paymentPayload: VALID_BODY.paymentPayload,
        paymentRequirements: requirements,
      });
      assert.equal(requirementsRes.status, 400);
      assertVerifyRejection(await requirementsRes.json());
    } finally {
      await app.close();
    }
  });

  test('unknown keys inside paymentRequirements are still accepted', async () => {
    // `extra` is scheme-specific, and the transport must not judge it.
    const app = await serve();
    try {
      const res = await app.post('/verify', {
        paymentPayload: VALID_BODY.paymentPayload,
        paymentRequirements: {
          ...VALID_BODY.paymentRequirements,
          extra: { areFeesSponsored: true },
          schemeSpecificField: 'anything',
        },
      });
      assert.equal(res.status, 200);
    } finally {
      await app.close();
    }
  });

  test('values at the exact bounds still pass', async () => {
    // Off-by-one guard: 32/64 are inclusive maxima, not exclusive ones.
    const scheme = 's'.repeat(SCHEME_MAX);
    const network = `stellar:${'n'.repeat(NETWORK_MAX - 'stellar:'.length)}`;
    assert.equal(scheme.length, SCHEME_MAX);
    assert.equal(network.length, NETWORK_MAX);

    const app = await serve({ config: testConfig({ networks: [network] }) });
    try {
      const res = await app.post('/verify', {
        paymentPayload: { ...VALID_BODY.paymentPayload, scheme, network },
        paymentRequirements: { ...VALID_BODY.paymentRequirements, scheme, network },
      });
      assert.equal(res.status, 200);
    } finally {
      await app.close();
    }
  });
});
