/**
 * The RPC circuit breaker (issue #105).
 *
 * The invariants pinned here, in the order the issue lists them:
 *   - only connection-level failures (the RETRYABLE set) may open the breaker;
 *     a received RPC error response never does
 *   - while open, non-sendTransaction calls fail without dialling — asserted
 *     by call count, not timing
 *   - half-open after cooldown; a single probe decides
 *   - an in-flight sendTransaction is never aborted by a trip underneath it,
 *     and is never fast-failed by an already-open breaker either
 *   - transitions are logged and state is readable for /health/ready
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installRpcRetry, RpcBreakerOpenError } from '../src/rpc-retry.js';
import { transportError, scriptedFetch, failingFetch } from './helpers/rpc-fetch.js';

const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('what opens the breaker', () => {
  test('opens after the threshold of consecutive connection failures', async () => {
    const stub = failingFetch('ECONNREFUSED');
    globalThis.fetch = stub;
    const states = [];
    installRpcRetry({
      attempts: 1,
      baseDelayMs: 1,
      threshold: 3,
      cooldownMs: 60_000,
      forceIpv4: false,
      onStateChange: s => states.push(s),
    });

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), /simulated/);
    }
    // All three dialed — nothing was refused yet.
    assert.equal(stub.calls, 3);
    assert.equal(states.length, 1);
    assert.match(states[0], /open/);
    assert.match(states[0], /rpc\.invalid/);
  });

  test('an RPC error RESPONSE never opens the breaker', async () => {
    // The server answering — even with 500 forever — means it is up. Breaking
    // on received responses would convert real results into flaky ones.
    const stub = async () => {
      stub.calls++;
      return new Response('boom', { status: 500 });
    };
    stub.calls = 0;
    globalThis.fetch = stub;
    installRpcRetry({
      attempts: 1,
      baseDelayMs: 1,
      threshold: 2,
      cooldownMs: 60_000,
      forceIpv4: false,
    });

    await globalThis.fetch('http://rpc.invalid');
    await globalThis.fetch('http://rpc.invalid');
    await globalThis.fetch('http://rpc.invalid');
    assert.equal(stub.calls, 3, 'every call must still dial — breaker must stay closed');

    // And a connection failure afterwards needs the full threshold from zero.
    const failing = failingFetch('ETIMEDOUT');
    globalThis.fetch = failing;
    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'));
    assert.equal(failing.calls, 1, 'one failure after successes must not open anything');
  });

  test('failures count per host — a second host starts closed', async () => {
    const stub = failingFetch('ECONNREFUSED');
    globalThis.fetch = stub;
    installRpcRetry({
      attempts: 1,
      baseDelayMs: 1,
      threshold: 2,
      cooldownMs: 60_000,
      forceIpv4: false,
    });

    await assert.rejects(() => globalThis.fetch('http://a.invalid'));
    // b.invalid has its own breaker; this dial must happen.
    await assert.rejects(() => globalThis.fetch('http://b.invalid'));
    assert.equal(stub.calls, 2);
  });
});

describe('while open', () => {
  test('calls fail immediately without dialling, with a distinct error', async () => {
    const stub = failingFetch('ECONNREFUSED');
    globalThis.fetch = stub;
    installRpcRetry({
      attempts: 1,
      baseDelayMs: 1,
      threshold: 1,
      cooldownMs: 60_000,
      forceIpv4: false,
    });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'));
    assert.equal(stub.calls, 1);

    // Open now. The next call must not reach the network at all.
    await assert.rejects(
      () => globalThis.fetch('http://rpc.invalid'),
      err => {
        assert.ok(err instanceof RpcBreakerOpenError);
        assert.equal(err.code, 'RPC_BREAKER_OPEN');
        return true;
      },
    );
    assert.equal(stub.calls, 1, 'no dial happened while the breaker was open');
  });
});

describe('half-open recovery', () => {
  test('after the cooldown one probe dials; success closes, failure re-opens', async () => {
    let healthy = false;
    const stub = async () => {
      stub.calls++;
      if (healthy) return new Response('ok');
      const err = new Error('simulated ECONNRESET');
      err.code = 'ECONNRESET';
      throw err;
    };
    stub.calls = 0;
    globalThis.fetch = stub;
    const lines = [];
    installRpcRetry({
      attempts: 1,
      baseDelayMs: 1,
      threshold: 1,
      cooldownMs: 30,
      forceIpv4: false,
      log: l => lines.push(l),
    });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'));
    assert.equal(stub.calls, 1); // open

    // Still inside cooldown: refused without dialling.
    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), RpcBreakerOpenError);
    assert.equal(stub.calls, 1);

    // Cooldown elapsed: exactly ONE probe goes through.
    await new Promise(r => setTimeout(r, 40));
    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), /simulated ECONNRESET/);
    assert.equal(stub.calls, 2, 'the probe dialled once');
    // The probe failed, so a second immediate caller is refused again.
    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), RpcBreakerOpenError);
    assert.equal(stub.calls, 2);

    // Cooldown again, but now the dependency recovered.
    healthy = true;
    await new Promise(r => setTimeout(r, 40));
    const res = await globalThis.fetch('http://rpc.invalid');
    assert.equal(await res.text(), 'ok');
    assert.equal(stub.calls, 3);

    // Closed: traffic flows without refusals.
    await globalThis.fetch('http://rpc.invalid');
    assert.equal(stub.calls, 4);

    const transitions = lines.filter(l => l.includes('OPEN') || l.includes('CLOSED'));
    assert.ok(
      transitions.some(l => l.includes('OPEN')),
      'opening is logged',
    );
    assert.ok(
      transitions.some(l => l.includes('CLOSED')),
      'closing is logged',
    );
  });

  test('state is readable for the readiness endpoint', async () => {
    const stub = failingFetch('ECONNREFUSED');
    globalThis.fetch = stub;
    const handle = installRpcRetry({
      attempts: 1,
      baseDelayMs: 1,
      threshold: 1,
      cooldownMs: 60_000,
      forceIpv4: false,
    });

    await assert.rejects(() => globalThis.fetch('http://rpc.invalid:8545/path'));
    const states = handle.getBreakerStates();
    assert.equal(states['http://rpc.invalid:8545'].state, 'open');
    assert.equal(states['http://rpc.invalid:8545'].consecutive_failures, 1);
    assert.ok(states['http://rpc.invalid:8545'].opened_at);
  });
});

describe('an open breaker produces a distinct reason code on /verify and /settle', async () => {
  const { serve, testConfig, stubFacilitator, VALID_BODY } = await import('./helpers/app.js');
  const { RpcBreakerOpenError } = await import('../src/rpc-retry.js');

  function brokenFacilitator() {
    return stubFacilitator({
      verify: async () => {
        throw new RpcBreakerOpenError('http://rpc.invalid');
      },
      settle: async () => {
        throw new RpcBreakerOpenError('http://rpc.invalid');
      },
    });
  }

  test('/verify answers soroban_rpc_unreachable, not facilitator_error', async () => {
    const app = await serve({
      facilitator: brokenFacilitator(),
      config: testConfig({ apiKeys: [] }),
    });
    try {
      const res = await app.post('/verify', VALID_BODY);
      const body = await res.json();
      assert.equal(body.isValid, false);
      assert.equal(body.invalidReason, 'soroban_rpc_unreachable');
    } finally {
      await app.close();
    }
  });

  test('/settle answers soroban_rpc_unreachable with the settle response shape', async () => {
    const app = await serve({ facilitator: brokenFacilitator() });
    try {
      const res = await app.post('/settle', VALID_BODY);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.errorReason, 'soroban_rpc_unreachable');
      assert.equal(body.transaction, '');
      assert.ok(body.network, 'network present even on failure');
    } finally {
      await app.close();
    }
  });
});

describe('sendTransaction is never aborted by the breaker', () => {
  const SEND_INIT = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: { transaction: 'AAAA...', resourceConfig: {} },
    }),
  };

  test('an open breaker still lets a sendTransaction dial', async () => {
    const stub = failingFetch('ECONNRESET');
    globalThis.fetch = stub;
    installRpcRetry({
      attempts: 1,
      baseDelayMs: 1,
      threshold: 1,
      cooldownMs: 60_000,
      forceIpv4: false,
    });

    // Trip it with an ordinary call (getHealth).
    await assert.rejects(() =>
      globalThis.fetch('http://rpc.invalid', {
        method: 'POST',
        body: JSON.stringify({ method: 'getHealth' }),
      }),
    );
    assert.equal(stub.calls, 1);

    // Ordinary calls are now refused...
    await assert.rejects(() => globalThis.fetch('http://rpc.invalid'), RpcBreakerOpenError);
    assert.equal(stub.calls, 1);

    // ...but a broadcast that may be live always gets its dial.
    await assert.rejects(() => globalThis.fetch('http://rpc.invalid', SEND_INIT), /simulated/);
    assert.equal(stub.calls, 2, 'sendTransaction must not be fast-failed while open');
  });

  test('a sendTransaction mid-retry-loop rides out a trip caused by other hosts', async () => {
    // Host A fails repeatedly, tripping ITS breaker; meanwhile host B's
    // sendTransaction keeps retrying — its own loop is not re-gated.
    const stub = scriptedFetch(
      transportError('ECONNRESET'),
      transportError('ECONNRESET'),
      new Response('ok'),
    );
    globalThis.fetch = stub;
    installRpcRetry({
      attempts: 5,
      baseDelayMs: 1,
      threshold: 1,
      cooldownMs: 60_000,
      forceIpv4: false,
    });

    const res = await globalThis.fetch('http://b.invalid/soroban', SEND_INIT);
    assert.equal(res.status, 200);
    assert.equal(stub.calls, 3, 'the send retried through to success despite trips elsewhere');
  });
});
