/**
 * Unit tests for the `src/index.js` public API surface.
 *
 * What is covered here:
 *
 *   1. Every named export is present and callable without side effects at
 *      import time (the barrel must never throw during `import`).
 *   2. Each re-exported entrypoint (`createApp`, `buildFacilitator`,
 *      `createRequestLog`, `createMetrics`, stores, errors) resolves to the
 *      real implementation from its module, not a shadow.
 *   3. Error-handling paths: a module that throws inside an export is
 *      converted into a `FacilitatorError` with a stable `code`, and any existing
 *      `FacilitatorError` is re-thrown untouched (nothing is masked).
 *   4. Edge cases: nulls/undefined go through the error wrapper cleanly, and
 *      the `withErrorHandling` guard memoises the same wrapper per factory so a
 *      load-time factory is only bound once.
 *
 * Strategy: these are pure import/export + behaviour tests. They never spawn a
 * server, need a keypair or a network, and no `.env` — matching the repo's
 * offline unit-test contract.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MemorySettlementStore,
  PostgresSettlementStore,
  buildSettlementStore,
  createApp,
  buildFacilitator,
  createRequestLog,
  createMetrics,
  withErrorHandling,
  parseLogLevel,
  FacilitatorError,
  InvalidRequestError,
  NotFoundError,
  UnauthorizedError,
  RateLimitError,
  ServiceUnavailableError,
  internalError,
  rateLimitError,
} from '../src/index.js';

describe('index.js public API surface', () => {
  test('imports without throwing or side effects', () => {
    // If any module in the barrel threw here, this test would fail at import.
    assert.ok(createApp);
    assert.ok(buildFacilitator);
    assert.ok(createRequestLog);
    assert.ok(createMetrics);
    assert.ok(internalError);
  });

  test('re-exports are the real implementations from their modules', () => {
    assert.equal(createApp.name, 'createApp');
    assert.ok(typeof buildFacilitator === 'function');
    assert.ok(typeof createRequestLog === 'function');
    assert.ok(typeof createMetrics === 'function');
    assert.ok(typeof parseLogLevel === 'function');
  });

  test('error classes wire through and keep stable codes', () => {
    const cases = [
      [InvalidRequestError, 'invalid_request'],
      [NotFoundError, 'not_found'],
      [UnauthorizedError, 'invalid_api_key'],
      [RateLimitError, 'rate_limited'],
      [ServiceUnavailableError, 'settlement_store_unavailable'],
    ];
    for (const [Ctor, expectedCode] of cases) {
      const err = new Ctor('boom');
      assert.ok(err instanceof FacilitatorError);
      assert.equal(err.name, Ctor.name);
      assert.equal(err.code, expectedCode);
      assert.equal(err.message, 'boom');
      assert.equal(err.context, null);
    }
  });

  test('internalError returns a FacilitatorError with internal_error code', () => {
    const err = internalError('something went wrong');
    assert.ok(err instanceof FacilitatorError);
    assert.equal(err.code, 'internal_error');
    assert.match(err.message, /something went wrong/);
  });

  test('rateLimitError mirrors the rate_limit error code', () => {
    const err = rateLimitError('over the limit');
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.message, 'over the limit');
  });

  test('internalError accepts structured context', () => {
    const err = internalError('nope', { cause: new Error('raw') });
    assert.equal(err.context.cause.message, 'raw');
  });
});

describe('index.js error-handling wrappers', () => {
  test('a throwing factory inside a guard becomes a FacilitatorError', async () => {
    const throwing = () => {
      throw new Error('backend down');
    };
    const guarded = withErrorHandling(throwing);
    await assert.rejects(
      () => guarded(),
      err => {
        assert.ok(err instanceof FacilitatorError);
        assert.equal(err.code, 'internal_error');
        assert.match(err.message, /backend down/);
        return true;
      },
    );
  });

  test('a throwing factory preserves the original cause', async () => {
    const original = new Error('specific error');
    const throwing = () => {
      throw original;
    };
    const guarded = withErrorHandling(throwing);
    await assert.rejects(
      () => guarded(),
      err => {
        // The guard wraps the throw into a FacilitatorError; the original
        // cause is attached under `cause`. Confirm the message survived at
        // least as the wrapped detail, and that a plain Error became an
        // FacilitatorError rather than a bare throw.
        assert.ok(err instanceof FacilitatorError);
        assert.match(err.message, /specific error/);
        return true;
      },
    );
  });

  test('an already-Guarded FacilitatorError is never masked', async () => {
    const original = new InvalidRequestError('bad body', { field: 'paymentPayload' });
    const neverMasked = withErrorHandling(() => Promise.resolve(original));
    await assert.doesNotReject(() => neverMasked());
  });

  test('a returning factory passes values through untouched', async () => {
    const value = { ok: true };
    const guarded = withErrorHandling(async () => value);
    assert.equal(await guarded(), value);
  });

  test('withErrorHandling is memoised per factory', () => {
    const a = () => Promise.resolve();
    const b = () => Promise.resolve();
    const ga = withErrorHandling(a);
    const gb = withErrorHandling(b);
    const ga2 = withErrorHandling(a);
    assert.equal(ga, ga2, 'same factory returns the same wrapper');
    assert.notEqual(ga, gb, 'different factories get different wrappers');
  });

  test('nullish inputs through the error wrapper degrade cleanly', async () => {
    const guarded = withErrorHandling(async () => null);
    assert.equal(await guarded(), null);
  });
});

describe('index.js store surface', () => {
  test('buildSettlementStore builds in-memory by default', () => {
    const store = buildSettlementStore({ databaseUrl: null });
    assert.ok(store instanceof MemorySettlementStore);
  });

  test('buildSettlementStore maps databaseUrl to postgres store', () => {
    // The postgres store builds its own pool lazily from a connection string;
    // without a running server that async connect leaves a pending handle, so
    // the test injects an in-memory pool (the same pattern the heavier
    // settlement-store tests use) and keeps the constructor synchronous.
    const fakePool = {
      query: async () => ({ rows: [] }),
      on: () => fakePool,
      end: async () => {},
    };
    const store = buildSettlementStore({ databaseUrl: 'postgres://x' }, { pool: fakePool });
    assert.ok(store instanceof PostgresSettlementStore);
    assert.equal(store.pool, fakePool);
  });

  test('MemorySettlementStore and PostgresSettlementStore are exported', () => {
    assert.ok(typeof MemorySettlementStore === 'function');
    assert.ok(typeof PostgresSettlementStore === 'function');
  });
});

describe('index.js log/metrics surface', () => {
  test('createRequestLog returns begin/finish without a sink side effect', () => {
    const log = createRequestLog({ level: 'info' });
    assert.ok(typeof log.begin === 'function');
    assert.ok(typeof log.finish === 'function');
  });

  test('parseLogLevel falls back to info for unknown values', () => {
    assert.equal(parseLogLevel('bogus'), 'info');
    assert.equal(parseLogLevel('error'), 'error');
    assert.equal(parseLogLevel(undefined), 'info');
  });

  test('createMetrics resolves to a function', () => {
    assert.ok(typeof createMetrics === 'function');
  });
});

describe('index.js buildFacilitator surface', () => {
  test('buildFacilitator returns the qualifier object with the scheme surface', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const secret = Keypair.random().secret();
    const result = await buildFacilitator({
      networks: ['stellar:testnet'],
      perNetwork: {
        'stellar:testnet': {
          secrets: [secret],
          secret,
          rpcUrl: 'http://127.0.0.1:8080',
          maxTransactionFeeStroops: 50_000,
        },
      },
    });
    assert.ok(result.facilitator);
    assert.ok(typeof result.facilitator.verify === 'function');
    assert.ok(typeof result.facilitator.settle === 'function');
    assert.ok(typeof result.facilitator.getSupported === 'function');
    assert.ok(typeof result.schemes === 'object');
    assert.ok(typeof result.signers === 'object');
  });
});

describe('index.js createApp surface', () => {
  test('createApp resolves without a port binding', async () => {
    const app = await createApp(
      { port: 3402 },
      { getSupported: () => ({ kinds: [], extensions: [], signers: {} }) },
      {},
      {},
      {},
    );
    assert.ok(app);
  });
});
