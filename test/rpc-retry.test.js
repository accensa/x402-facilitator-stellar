/**
 * installRpcRetry.
 *
 * The distinction this module exists to hold is the one worth pinning: failures
 * raised *before* a response is received are retried; anything the server
 * actually said stands. Retrying a rejected simulation or a failed settlement
 * would convert a real failure into a flaky success, which is the class of bug
 * this repo exists to avoid.
 *
 * forceIpv4 is off throughout — the IPv4 connector is about reaching a real
 * host, and these tests never leave the process.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installRpcRetry } from '../src/rpc-retry.js';

/** The real fetch, restored after every test so the wrapper cannot leak. */
const REAL_FETCH = globalThis.fetch;

/** Builds an error shaped like the ones undici raises. */
function transportError(code, { onCause = false } = {}) {
  const err = new Error(`simulated ${code}`);
  if (onCause) err.cause = { code };
  else err.code = code;
  return err;
}

/** A fetch stub that plays a scripted sequence and counts its calls. */
function scriptedFetch(...outcomes) {
  const stub = async () => {
    stub.calls++;
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response('ok');
  };
  stub.calls = 0;
  return stub;
}

beforeEach(() => {
  globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('what is retried', () => {
  for (const code of [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ]) {
    test(`${code} is retried and can succeed`, async () => {
      const stub = scriptedFetch(transportError(code), new Response('recovered'));
      globalThis.fetch = stub;
      installRpcRetry({ attempts: 3, baseDelayMs: 1, forceIpv4: false });

      const res = await globalThis.fetch('http://rpc.invalid');
      assert.equal(await res.text(), 'recovered');
      assert.equal(stub.calls, 2);
    });
  }

  test('the code is read from err.cause too, not only err.code', async () => {
    // undici wraps the real cause, and reading only the top-level code is how
    // a retryable failure gets misclassified as fatal.
    const stub = scriptedFetch(
      transportError('UND_ERR_CONNECT_TIMEOUT', { onCause: true }),
      new Response('recovered'),
    );
    globalThis.fetch = stub;
    installRpcRetry({ attempts: 3, baseDelayMs: 1, forceIpv4: false });

    assert.equal(await (await globalThis.fetch('http://rpc.invalid')).text(), 'recovered');
    assert.equal(stub.calls, 2);
  });
});

describe('what is deliberately not retried', () => {
  test('an HTTP error response is returned as-is, never retried', async () => {
    // This is the important one. A 500 from the RPC is the server answering.
    // Retrying it would turn a real failure into an intermittent success.
    const stub = scriptedFetch(new Response('boom', { status: 500 }));
    globalThis.fetch = stub;
    installRpcRetry({ attempts: 5, baseDelayMs: 1, forceIpv4: false });

    const res = await globalThis.fetch('http://rpc.invalid');
    assert.equal(res.status, 500);
    assert.equal(stub.calls, 1, 'an answered request must not be retried');
  });

  test('a non-transport error is rethrown on the first attempt', async () => {
    const stub = scriptedFetch(transportError('ERR_INVALID_URL'));
    globalThis.fetch = stub;
    installRpcRetry({ attempts: 5, baseDelayMs: 1, forceIpv4: false });

    await assert.rejects(() => globalThis.fetch('not a url'), /simulated ERR_INVALID_URL/);
    assert.equal(stub.calls, 1);
  });

  test('an error with no code at all is not retried', async () => {
    const stub = scriptedFetch(new Error('something else entirely'));
    globalThis.fetch = stub;
    installRpcRetry({ attempts: 5, baseDelayMs: 1, forceIpv4: false });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), /something else entirely/);
    assert.equal(stub.calls, 1);
  });
});

describe('attempt bounds', () => {
  test('attempts is a total, including the first call', async () => {
    const stub = scriptedFetch(
      transportError('ETIMEDOUT'),
      transportError('ETIMEDOUT'),
      transportError('ETIMEDOUT'),
    );
    globalThis.fetch = stub;
    installRpcRetry({ attempts: 2, baseDelayMs: 1, forceIpv4: false });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), /simulated ETIMEDOUT/);
    assert.equal(stub.calls, 2, 'attempts: 2 means two calls, not two retries');
  });

  test('the last error is what surfaces after exhausting attempts', async () => {
    const stub = scriptedFetch(transportError('ETIMEDOUT'), transportError('ECONNRESET'));
    globalThis.fetch = stub;
    installRpcRetry({ attempts: 2, baseDelayMs: 1, forceIpv4: false });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), /simulated ECONNRESET/);
  });

  test('attempts: 1 disables retrying entirely', async () => {
    const stub = scriptedFetch(transportError('ETIMEDOUT'), new Response('never reached'));
    globalThis.fetch = stub;
    installRpcRetry({ attempts: 1, baseDelayMs: 1, forceIpv4: false });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'));
    assert.equal(stub.calls, 1);
  });
});

describe('logging', () => {
  test('each retry is logged once, with the code and the attempt', async () => {
    const lines = [];
    const stub = scriptedFetch(
      transportError('ETIMEDOUT'),
      transportError('ETIMEDOUT'),
      new Response('ok'),
    );
    globalThis.fetch = stub;
    installRpcRetry({ attempts: 4, baseDelayMs: 1, forceIpv4: false, log: l => lines.push(l) });

    await globalThis.fetch('http://rpc.invalid/soroban');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /ETIMEDOUT/);
    assert.match(lines[0], /rpc\.invalid/);
    assert.match(lines[0], /retry 1/);
    assert.match(lines[1], /retry 2/);
  });

  test('a successful first attempt logs nothing', async () => {
    const lines = [];
    globalThis.fetch = scriptedFetch(new Response('ok'));
    installRpcRetry({ attempts: 3, baseDelayMs: 1, forceIpv4: false, log: l => lines.push(l) });

    await globalThis.fetch('http://rpc.invalid');
    assert.deepEqual(lines, []);
  });
});

describe('the wrapper does not leak', () => {
  test('installing replaces globalThis.fetch, and the harness restores it', async () => {
    assert.equal(globalThis.fetch, REAL_FETCH, 'beforeEach must hand back the real fetch');
    globalThis.fetch = scriptedFetch(new Response('ok'));
    installRpcRetry({ attempts: 1, baseDelayMs: 1, forceIpv4: false });
    assert.notEqual(globalThis.fetch, REAL_FETCH);
    // afterEach restores it; the assertion above in the next test proves it.
  });

  test('the previous test left the real fetch behind', () => {
    assert.equal(globalThis.fetch, REAL_FETCH);
  });
});
