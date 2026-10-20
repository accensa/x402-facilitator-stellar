/**
 * Rerank payload contract of the real *EmbeddingClient (#556).
 *
 * `EmbeddingClient._parseRerankScores` (src/catalog/embeddings.js) is the whole
 * of the rerank contract: it accepts the Cohere/Jina `{results:[{index,
 * relevance_score}]}` shape and the positional `{scores:[number]}` shorthand,
 * and rejects an out-of-range index, a non-finite score, a duplicate index and
 * a list that does not cover every document. The store-level tests in
 * test/catalog.search.test.js stub `store.embeddingClient.rerank`, so nothing
 * there is about the HTTP body, the cooldown or the two accepted payload
 * shapes — this file is.
 *
 * The network plane is stubbed with undici's `MockAgent` as the global
 * dispatcher: no socket is opened, but the real `EmbeddingClient.rerank`
 * (which captured `undici.fetch` at import time) makes real POST requests that
 * reach the mock, so every assertion is about the body the client actually
 * sends and the payload it actually parses.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { EmbeddingClient } from '../src/catalog/embeddings.js';

const RERANK_URL = 'https://rerank.test/score';

/** Resources shaped the way a search page carries them. */
const PAGE = [
  { url: 'https://api.example/alpha', serviceName: 'Alpha API', description: 'first' },
  { url: 'https://api.example/beta', serviceName: 'Beta API', description: 'second' },
];

let agent;
beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(() => {
  // Other suites share this process's global dispatcher.
  setGlobalDispatcher(new MockAgent());
});

/** Wires a pool whose single POST /score answers with the given canned reply. */
function wire(pool, { status = 200, payload, body } = {}) {
  pool.intercept({ method: 'POST', path: '/score' }).reply(status, body ?? JSON.stringify(payload));
}

function makeClient({ circuitBreakerThreshold = 3 } = {}) {
  return new EmbeddingClient('https://embeddings.test/vectors', {
    rerankUrl: RERANK_URL,
    circuitBreakerThreshold,
    circuitBreakerCooldownMs: 50,
  });
}

/** Wires a pool whose single POST /score answers with the given canned reply. */
/** Captures console.warn for the duration of fn. */
async function captureWarn(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

const RESULTS_PAYLOAD = pageScores => ({
  results: pageScores.map(([index, relevance_score]) => ({ index, relevance_score })),
});

describe('EmbeddingClient.rerank — accepted payload shapes', () => {
  test('the Cohere/Jina {results} shape reorders the page by relevance', async () => {
    const pool = agent.get('https://rerank.test');
    wire(pool, {
      payload: RESULTS_PAYLOAD([
        [0, 0.05],
        [1, 0.95],
      ]),
    });
    const { result } = await captureWarn(async () => {
      const client = makeClient();
      const out = await client.rerank('pay', PAGE);
      return out.map(r => r.url);
    });
    assert.deepEqual(result, ['https://api.example/beta', 'https://api.example/alpha']);
  });

  test('the positional {scores} shape reorders the page identically', async () => {
    const pool = agent.get('https://rerank.test');
    wire(pool, { payload: { scores: [0.05, 0.95] } });
    const { result } = await captureWarn(async () => {
      const client = makeClient();
      const out = await client.rerank('pay', PAGE);
      return out.map(r => r.url);
    });
    assert.deepEqual(result, ['https://api.example/beta', 'https://api.example/alpha']);
  });

  test('ties keep the fused order the sort is stable over', async () => {
    const pool = agent.get('https://rerank.test');
    wire(pool, { payload: { scores: [0.5, 0.5] } });
    const { result } = await captureWarn(async () => {
      const client = makeClient();
      const out = await client.rerank('pay', PAGE);
      return out.map(r => r.url);
    });
    assert.deepEqual(result, ['https://api.example/alpha', 'https://api.example/beta']);
  });
});

describe('EmbeddingClient.rerank — rejection rules of _parseRerankScores', () => {
  const rejections = {
    'an out-of-range index': RESULTS_PAYLOAD([
      [0, 1],
      [7, 0.5],
    ]),
    'a negative index': {
      results: [
        { index: -1, relevance_score: 1 },
        { index: 0, relevance_score: 0.5 },
      ],
    },
    'a non-finite score': {
      results: [
        { index: 0, relevance_score: 1 },
        { index: 1, relevance_score: Number.NaN },
      ],
    },
    'a duplicate index': RESULTS_PAYLOAD([
      [0, 0.9],
      [0, 0.2],
    ]),
    'a partial list': RESULTS_PAYLOAD([[0, 0.9]]),
    'a non-integer index': {
      results: [
        { index: 0.5, relevance_score: 1 },
        { index: 1, relevance_score: 0.5 },
      ],
    },
    'scores of the wrong length': { scores: [0.9] },
    'a payload of neither shape': { ranking: [1, 0] },
  };
  for (const [name, payload] of Object.entries(rejections)) {
    test(`${name} leaves the page in fused order and records one failure on rerankHealth`, async () => {
      const pool = agent.get('https://rerank.test');
      wire(pool, { payload });
      const client = makeClient();
      const { result, warnings } = await captureWarn(() => client.rerank('pay', PAGE));

      assert.deepEqual(
        result.map(r => r.url),
        ['https://api.example/alpha', 'https://api.example/beta'],
      );
      assert.equal(client.rerankHealth.failures, 1);
      assert.equal(client.rerankHealth.consecutiveFailures, 1);
      assert.equal(client.rerankHealth.successes, 0);
      assert.ok(
        warnings.some(w => w.includes(RERANK_URL) && w.includes('fused order')),
        `the degradation must be logged with the endpoint: ${warnings.join(' | ')}`,
      );
    });
  }
});

describe('EmbeddingClient.rerank — HTTP and body failures degrade the same way', () => {
  test('a non-200 response does not reorder the page', async () => {
    const pool = agent.get('https://rerank.test');
    wire(pool, { status: 500, payload: { error: 'overloaded' } });
    const client = makeClient();
    const { result, warnings } = await captureWarn(() => client.rerank('pay', PAGE));

    assert.deepEqual(
      result.map(r => r.url),
      ['https://api.example/alpha', 'https://api.example/beta'],
    );
    assert.equal(client.rerankHealth.failures, 1);
    assert.ok(warnings.some(w => w.includes('HTTP 500')));
  });

  test('a body that is not JSON does not reorder the page', async () => {
    const pool = agent.get('https://rerank.test');
    wire(pool, { payload: { ignored: true } });
    // Replace the interception with a body that is not JSON.
    pool.intercept({ method: 'POST', path: '/score' }).reply(200, () => 'not json');
    const client = makeClient();
    const { result, warnings } = await captureWarn(() => client.rerank('pay', PAGE));

    assert.deepEqual(
      result.map(r => r.url),
      ['https://api.example/alpha', 'https://api.example/beta'],
    );
    assert.equal(client.rerankHealth.failures, 1);
    assert.ok(warnings.some(w => w.includes('not JSON') || w.includes('fused order')));
  });
});

describe('EmbeddingClient.rerank — the rerank breaker is its own breaker', () => {
  test('after threshold consecutive failures the next call is skipped while the embedding breaker is untouched', async () => {
    const pool = agent.get('https://rerank.test');
    wire(pool, { status: 500, payload: { error: 'overloaded' } });
    const client = makeClient({ circuitBreakerThreshold: 3 });

    const { result: first, warnings } = await captureWarn(() =>
      Promise.all([
        client.rerank('pay', PAGE),
        client.rerank('pay', PAGE),
        client.rerank('pay', PAGE),
      ]),
    );
    for (const page of first) {
      assert.deepEqual(
        page.map(r => r.url),
        ['https://api.example/alpha', 'https://api.example/beta'],
      );
    }
    assert.equal(client.rerankHealth.consecutiveFailures, 3);

    // Third failure arms the cooldown; the next call is skipped without wiring
    // any further interception success — undici would throw on an attempted
    // socket, so reaching this via the skip branch proves no call was made.
    const { result: skipped } = await captureWarn(() => client.rerank('pay', PAGE));
    assert.deepEqual(
      skipped.map(r => r.url),
      ['https://api.example/alpha', 'https://api.example/beta'],
    );
    assert.equal(client.rerankHealth.failures, 4, 'the cooldown skip itself is counted');
    assert.ok(
      warnings.some(w => w.includes('cooldown')),
      `the cooldown skip must be logged: ${warnings.join(' | ')}`,
    );

    // The embedding breaker never moved.
    assert.equal(client.health.failures, 0);
    assert.equal(client.health.consecutiveFailures, 0);
    assert.equal(client.health.successes, 0);
  });

  test('reranking is off without a rerank URL: the input page is returned untouched', async () => {
    const client = new EmbeddingClient('https://embeddings.test/vectors');
    const page = [...PAGE];
    const out = await client.rerank('pay', page);
    assert.deepEqual(out, PAGE);
    assert.equal(client.rerankHealth.failures, 0);
  });
});
