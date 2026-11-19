/**
 * readPaymentBody must not default the wire route (#656).
 *
 * The failure envelopes are selected by the route alone, so a defaulted
 * `verify` answered a failed settle with the verify envelope. The route is now
 * required, and anything outside verify/settle is a TypeError.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readPaymentBody } from '../src/payment-body.js';

const CONFIG = { networks: ['stellar:testnet'] };
const INVALID_BODY = {
  paymentPayload: {},
  paymentRequirements: { scheme: 'exact', network: 'unknown:net' },
};

function fakeReply() {
  const reply = {
    statusCode: null,
    body: null,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
  return reply;
}

describe('src/payment-body.js route handling (#656)', () => {
  test('a failed settle returns the settle failure envelope', () => {
    const reply = fakeReply();
    const res = readPaymentBody({ body: INVALID_BODY }, reply, CONFIG, 'settle');
    assert.equal(res, null);
    assert.equal(reply.statusCode, 400);
    assert.equal(reply.body.success, false);
    assert.equal(reply.body.errorReason, 'unsupported_network');
    assert.equal(reply.body.transaction, '');
    assert.equal(reply.body.network, 'unknown:net');
    assert.equal(reply.body.isValid, undefined);
  });

  test('a failed verify returns the verify failure envelope', () => {
    const reply = fakeReply();
    const res = readPaymentBody({ body: INVALID_BODY }, reply, CONFIG, 'verify');
    assert.equal(res, null);
    assert.equal(reply.statusCode, 400);
    assert.equal(reply.body.isValid, false);
    assert.equal(reply.body.invalidReason, 'unsupported_network');
    assert.match(reply.body.invalidMessage, /network "unknown:net" is not served/);
    assert.equal(reply.body.success, undefined);
  });

  test('a bad route is rejected instead of falling back to verify', () => {
    const reply = fakeReply();
    assert.throws(
      () => readPaymentBody({ body: INVALID_BODY }, reply, CONFIG, 'refund'),
      /readPaymentBody: route must be 'verify' or 'settle'/,
    );
  });

  test('an omitted route is rejected instead of defaulting to verify', () => {
    const reply = fakeReply();
    assert.throws(() => readPaymentBody({ body: INVALID_BODY }, reply, CONFIG), TypeError);
  });
});
