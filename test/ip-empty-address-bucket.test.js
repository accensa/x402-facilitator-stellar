import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpPseudonymizationHook, createIpPseudonymizer, pseudonymizeIp } from '../src/ip.js';
import { RateLimiter } from '../src/rate-limit.js';

function replyRecorder() {
  return {
    status: 200,
    body: undefined,
    sent: false,
    code(status) {
      this.status = status;
      return this;
    },
    send(body) {
      this.sent = true;
      this.body = body;
      return this;
    },
  };
}

test('pseudonymizeIp treats an empty address as absent', () => {
  assert.equal(pseudonymizeIp(''), undefined);
});

test('the hook uses a valid resolved address before the socket peer', async () => {
  const hook = createIpPseudonymizationHook(createIpPseudonymizer(), () => {});
  const req = { ip: '203.0.113.7', socket: { remoteAddress: '198.51.100.9' } };
  await hook(req, replyRecorder());
  assert.match(req.ip, /^[0-9a-f]{24}$/);
  assert.equal(req.ip, pseudonymizeIp('203.0.113.7'));
});

test('the hook falls back to the socket peer for an empty resolved address', async () => {
  const hook = createIpPseudonymizationHook(createIpPseudonymizer(), () => {});
  const req = { ip: '', socket: { remoteAddress: '198.51.100.9' } };
  await hook(req, replyRecorder());
  assert.equal(req.ip, pseudonymizeIp('198.51.100.9'));
});

test('the hook clears req.ip and rejects when no address or peer exists', async () => {
  const audit = [];
  const hook = createIpPseudonymizationHook(createIpPseudonymizer(), (event, fields) => {
    audit.push({ event, ...fields });
  });
  const req = { ip: '', socket: {}, url: '/verify' };
  const reply = replyRecorder();
  await hook(req, reply);

  assert.equal(req.ip, undefined);
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.body, {
    error: 'invalid_request',
    reason: 'client_address_unresolved',
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, 'client_address_unresolved');
});

test('address-less requests no longer collide in a shared rate-limit bucket', async t => {
  const limiter = new RateLimiter({
    global: { verifyRpm: 1, settleRpm: 10, settleRph: 100, settleRpd: 1000, feeSpd: 1e9 },
    keys: {},
  });
  t.after(() => limiter.close());

  const hook = createIpPseudonymizationHook(createIpPseudonymizer(), () => {});
  const reqA = { ip: '', socket: { remoteAddress: '203.0.113.7' } };
  const reqB = { ip: '', socket: { remoteAddress: '198.51.100.9' } };
  await hook(reqA, replyRecorder());
  await hook(reqB, replyRecorder());

  assert.notEqual(reqA.ip, reqB.ip);
  await limiter.recordVerify(reqA);
  await limiter.recordVerify(reqB);
  assert.equal(limiter.store.map.size, 2);
});

test('unresolved address rejection occurs before token consumption', async t => {
  const limiter = new RateLimiter({
    global: { verifyRpm: 1, settleRpm: 10, settleRph: 100, settleRpd: 1000, feeSpd: 1e9 },
    keys: {},
  });
  t.after(() => limiter.close());
  const hook = createIpPseudonymizationHook(createIpPseudonymizer(), () => {});
  const req = { ip: '', socket: {} };
  const reply = replyRecorder();
  await hook(req, reply);
  assert.equal(reply.sent, true);
  assert.equal(limiter.store.map.size, 0);
});
