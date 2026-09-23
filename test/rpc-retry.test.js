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
 * host, and these tests never leave the process (except the explicit
 * dispatcher-path test, which still dials only the reserved `.invalid` TLD).
 *
 * The matrix is organised by the failure classes the wrapper can meet:
 *   - what is retried (pre-response transport failures)
 *   - what is deliberately NOT retried (answered requests, non-transport errors)
 *   - attempt bounds (total calls, not retries; last error surfaces)
 *   - logging and the structured onRetry hook
 *   - error surfacing (the exact original error rethrown, codes intact)
 *   - request-input handling (Request objects, unparsable hosts, sendTransaction
 *     body detection and its request-store side effect)
 *   - the no-leak harness contract
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installRpcRetry, RpcBreakerOpenError } from '../src/rpc-retry.js';
import { transportError, scriptedFetch, failingFetch } from './helpers/rpc-fetch.js';
import { requestState } from '../src/request-state.js';

/** The real fetch, restored after every test so the wrapper cannot leak. */
const REAL_FETCH = globalThis.fetch;

/** Installs the wrapper with the fast, off-network defaults used here. */
function installFast(options = {}) {
  return installRpcRetry({ attempts: 3, baseDelayMs: 1, forceIpv4: false, ...options });
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
      installFast();

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
    installFast();

    assert.equal(await (await globalThis.fetch('http://rpc.invalid')).text(), 'recovered');
    assert.equal(stub.calls, 2);
  });

  test('err.cause.code takes precedence over a top-level err.code', async () => {
    // The top-level code looks fatal while the real cause is retryable — the
    // retry decision must follow the cause, not the wrapper's outer error.
    const err = new Error('looks fatal from the outside');
    err.code = 'ERR_INVALID_URL';
    err.cause = { code: 'ETIMEDOUT' };
    const stub = scriptedFetch(err, new Response('recovered'));
    globalThis.fetch = stub;
    installFast();

    await globalThis.fetch('http://rpc.invalid');
    assert.equal(stub.calls, 2, 'the cause code must drive the retry decision');
  });
});

describe('what is deliberately not retried', () => {
  test('an HTTP error response is returned as-is, never retried', async () => {
    // This is the important one. A 500 from the RPC is the server answering.
    // Retrying it would turn a real failure into an intermittent success.
    const stub = scriptedFetch(new Response('boom', { status: 500 }));
    globalThis.fetch = stub;
    installFast({ attempts: 5 });

    const res = await globalThis.fetch('http://rpc.invalid');
    assert.equal(res.status, 500);
    assert.equal(stub.calls, 1, 'an answered request must not be retried');
  });

  test('a non-transport error is rethrown on the first attempt', async () => {
    const stub = scriptedFetch(transportError('ERR_INVALID_URL'));
    globalThis.fetch = stub;
    installFast({ attempts: 5 });

    await assert.rejects(() => globalThis.fetch('not a url'), /simulated ERR_INVALID_URL/);
    assert.equal(stub.calls, 1);
  });

  test('an error with no code at all is not retried', async () => {
    const stub = scriptedFetch(new Error('something else entirely'));
    globalThis.fetch = stub;
    installFast({ attempts: 5 });

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
    installFast({ attempts: 2 });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), /simulated ETIMEDOUT/);
    assert.equal(stub.calls, 2, 'attempts: 2 means two calls, not two retries');
  });

  test('the last error is what surfaces after exhausting attempts', async () => {
    const stub = scriptedFetch(transportError('ETIMEDOUT'), transportError('ECONNRESET'));
    globalThis.fetch = stub;
    installFast({ attempts: 2 });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), /simulated ECONNRESET/);
  });

  test('attempts: 1 disables retrying entirely', async () => {
    const stub = scriptedFetch(transportError('ETIMEDOUT'), new Response('never reached'));
    globalThis.fetch = stub;
    installFast({ attempts: 1 });

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
    installFast({ attempts: 4, log: l => lines.push(l) });

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
    installFast({ attempts: 3, log: l => lines.push(l) });

    await globalThis.fetch('http://rpc.invalid');
    assert.deepEqual(lines, []);
  });

  test('onRetry is invoked once per retry with structured fields', async () => {
    const retries = [];
    const stub = scriptedFetch(
      transportError('ETIMEDOUT'),
      transportError('ECONNRESET'),
      new Response('ok'),
    );
    globalThis.fetch = stub;
    installFast({ onRetry: info => retries.push(info) });

    await globalThis.fetch('http://rpc.invalid:8545/soroban');

    assert.equal(retries.length, 2);
    assert.deepEqual(
      retries.map(r => ({ code: r.code, attempt: r.attempt, host: r.host, url: r.url })),
      [
        {
          code: 'ETIMEDOUT',
          attempt: 1,
          host: 'http://rpc.invalid:8545',
          url: 'http://rpc.invalid:8545/soroban',
        },
        {
          code: 'ECONNRESET',
          attempt: 2,
          host: 'http://rpc.invalid:8545',
          url: 'http://rpc.invalid:8545/soroban',
        },
      ],
    );
  });

  test('a successful first attempt never fires onRetry', async () => {
    const retries = [];
    globalThis.fetch = scriptedFetch(new Response('ok'));
    installFast({ onRetry: info => retries.push(info) });

    await globalThis.fetch('http://rpc.invalid');
    assert.deepEqual(retries, []);
  });
});

describe('error surfacing', () => {
  test('the exact original error is rethrown with its code intact', async () => {
    const boom = transportError('ECONNRESET');
    const stub = scriptedFetch(boom, boom);
    globalThis.fetch = stub;
    installFast({ attempts: 2 });

    await assert.rejects(
      () => globalThis.fetch('http://rpc.invalid'),
      err => {
        assert.equal(err, boom, 'the caller must receive the original error object');
        assert.equal(err.code, 'ECONNRESET');
        return true;
      },
    );
  });

  test('an open breaker raises a distinct code, not a raw network error', async () => {
    const stub = failingFetch('ECONNREFUSED');
    globalThis.fetch = stub;
    installFast({ attempts: 1, threshold: 1, cooldownMs: 60_000 });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'));

    await assert.rejects(
      () => globalThis.fetch('http://rpc.invalid'),
      err => {
        assert.ok(err instanceof RpcBreakerOpenError);
        assert.equal(err.code, 'RPC_BREAKER_OPEN');
        assert.equal(err.host, 'http://rpc.invalid');
        assert.match(err.message, /unreachable \(circuit open\)/);
        return true;
      },
    );
    assert.equal(stub.calls, 1, 'no dial happened while the breaker was open');
  });

  test('a final retryable failure also counts toward the breaker', async () => {
    const stub = failingFetch('ETIMEDOUT');
    globalThis.fetch = stub;
    const states = [];
    installFast({
      attempts: 1,
      threshold: 1,
      cooldownMs: 60_000,
      onStateChange: s => states.push(s),
    });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), /simulated ETIMEDOUT/);
    assert.equal(stub.calls, 1);
    assert.ok(
      states.some(s => /open/.test(s) && /rpc\.invalid/.test(s)),
      'the exhausted last attempt must open the breaker',
    );
  });
});

describe('request-input handling', () => {
  test('a Request-like object is used for the breaker host and the retry url', async () => {
    const stub = scriptedFetch(transportError('ETIMEDOUT'), new Response('recovered'));
    globalThis.fetch = stub;
    installFast();

    const req = new Request('http://rpc.invalid/soroban');
    const res = await globalThis.fetch(req);

    assert.equal(await res.text(), 'recovered');
    assert.equal(stub.calls, 2);
    assert.equal(stub.inputs[0], req);
  });

  test('a malformed input is bucketed under (unparsable) without crashing', async () => {
    const boom = new Error('retryable transport fault');
    boom.code = 'ETIMEDOUT';
    const stub = scriptedFetch(boom, new Response('ok'));
    globalThis.fetch = stub;
    installFast();

    await globalThis.fetch({ thisIs: 'not a request at all' });
    assert.equal(stub.calls, 2);
  });

  test('a sendTransaction body sets the request-store submitted flag', async () => {
    const store = {};
    globalThis.fetch = scriptedFetch(transportError('ETIMEDOUT'), new Response('ok'));
    installFast();

    await requestState.run(store, () =>
      globalThis.fetch('http://rpc.invalid', {
        method: 'POST',
        body: JSON.stringify({ method: 'sendTransaction', params: {} }),
      }),
    );

    assert.equal(store.submitted, true, 'the retried send must stay protected');
  });

  test('a non-sendTransaction body leaves the request store untouched', async () => {
    const store = {};
    globalThis.fetch = scriptedFetch(new Response('ok'));
    installFast();

    await requestState.run(store, () =>
      globalThis.fetch('http://rpc.invalid', {
        method: 'POST',
        body: JSON.stringify({ method: 'getHealth' }),
      }),
    );

    assert.equal(store.submitted, undefined);
  });

  test('a non-string body is never classified as sendTransaction', async () => {
    const store = {};
    globalThis.fetch = scriptedFetch(new Response('ok'));
    installFast();

    const req = new Request('http://rpc.invalid', { method: 'POST', body: '{}' });
    await requestState.run(store, () => globalThis.fetch(req));

    assert.equal(store.submitted, undefined);
  });

  test('forceIpv4 wraps the call in the undici IPv4 dispatcher and surfaces errors', async () => {
    // `.invalid` is a reserved TLD that never resolves: this exercises the
    // dispatcher wrapper without relying on external connectivity, and props
    // up the connection failure to the caller rather than throwing in the
    // wiring.
    installFast({ attempts: 1, forceIpv4: true });
    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'));
  });
});

describe('the wrapper does not leak', () => {
  test('installing replaces globalThis.fetch, and the harness restores it', async () => {
    assert.equal(globalThis.fetch, REAL_FETCH, 'beforeEach must hand back the real fetch');
    globalThis.fetch = scriptedFetch(new Response('ok'));
    installFast({ attempts: 1 });
    assert.notEqual(globalThis.fetch, REAL_FETCH);
    // afterEach restores it; the assertion above in the next test proves it.
  });

  test('the previous test left the real fetch behind', () => {
    assert.equal(globalThis.fetch, REAL_FETCH);
  });
});
