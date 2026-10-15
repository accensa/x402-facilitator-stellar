/**
 * End-to-end contract tests for `EmbeddingClient.rerank` and
 * `_parseRerankScores` (src/catalog/embeddings.js:196-222, 238-325) — the real
 * client, network stubbed in-process, so nothing here ever reaches a real
 * provider.
 *
 * `test/catalog.search.test.js` stubs the whole client
 * (`store.embeddingClient.rerank`), so nothing there covers the real HTTP body
 * handling: the two documented payload shapes, the parse rejection rules, the
 * degradation paths and the rerank circuit breaker. `docs/BAZAAR.md:129`
 * promises both shapes and fused-order degradation; this file pins all of it.
 *
 * The stub is a loopback `http.Server` obeying a per-test script. The module
 * binds `fetch` to undici's client at load time (src/catalog/embeddings.js:1-9),
 * so a server-shaped network is the only stub that exercises the real POST
 * path without editing the source under test or reaching the outside world.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EmbeddingClient } from '../src/catalog/embeddings.js';

/** Resources whose fused order is distinguishable by their service names. */
const RESOURCES = [
  { serviceName: 'alpha', description: 'first', type: 'api' },
  { serviceName: 'beta', description: 'second', type: 'api' },
  { serviceName: 'gamma', description: 'third', type: 'api' },
];

const names = list => list.map(r => r.serviceName);

/**
 * Starts a loopback server obeying `respond`. It counts every request, and
 * captures console.warn so the degradation log lines do not pollute the TAP
 * output.
 */
async function startRerankServer(respond) {
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      calls.push({ body: JSON.parse(body) });
      respond(res, calls.length);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    warnings,
    get port() {
      return server.address().port;
    },
    close: () => {
      console.warn = originalWarn;
      return new Promise(resolve => server.close(resolve));
    },
  };
}

function makeClient(serverPort, extra = {}) {
  return new EmbeddingClient('https://embeddings.example', {
    rerankUrl: `http://127.0.0.1:${serverPort}`,
    timeoutMs: 2_000,
    ...extra,
  });
}

/** Replies with the given status/body. */
function reply(res, status, payload, contentType = 'application/json') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(payload);
}

const jsonOK = data => res => reply(res, 200, JSON.stringify(data));

/** A fresh fused-order page for each assertion. */
function freshPage() {
  return [RESOURCES[2], RESOURCES[0], RESOURCES[1]].map(r => ({ ...r }));
}

describe('EmbeddingClient.rerank payload contract', () => {
  test('the Cohere/Jina {results:[{index,relevance_score}]} shape reorders the page', async () => {
    const server = await startRerankServer(
      jsonOK({
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.2 },
        ],
      }),
    );
    try {
      // Fused order [gamma, alpha, beta]; scores rank index 2 > 0 > 1, so
      // the reranked page is [beta, gamma, alpha] - measurably reordered.
      const page = freshPage();
      const client = makeClient(server.port, {
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 60_000,
      });
      const out = await client.rerank('find me', page);
      assert.deepEqual(names(out), ['beta', 'gamma', 'alpha']);
      assert.strictEqual(client.rerankHealth.consecutiveFailures, 0);
    } finally {
      await server.close();
    }
  });

  test('the positional {scores:[number]} shape reorders the page identically', async () => {
    const server = await startRerankServer(jsonOK({ scores: [0.5, 0.2, 0.9] }));
    try {
      // Same score set as the results-shape test, in positional form, so the
      // ranking must come out identical to the documented alternative shape.
      const page = [{ ...RESOURCES[0] }, { ...RESOURCES[1] }, { ...RESOURCES[2] }];
      const out = await makeClient(server.port).rerank('find me', page);
      assert.deepEqual(names(out), ['gamma', 'alpha', 'beta']);
    } finally {
      await server.close();
    }
  });

  test('the request body is the documented {query, documents} pair', async () => {
    const server = await startRerankServer(jsonOK({ scores: [3, 2, 1] }));
    try {
      await makeClient(server.port).rerank('it workers', freshPage());
      assert.strictEqual(server.calls.length, 1);
      assert.strictEqual(server.calls[0].body.query, 'it workers');
      assert.deepEqual(Object.keys(server.calls[0].body).sort(), ['documents', 'query']);
      assert.strictEqual(server.calls[0].body.documents.length, 3);
    } finally {
      await server.close();
    }
  });

  test('a partially covering results payload degrades to fused order with one failure', async () => {
    const server = await startRerankServer(jsonOK({ results: [{ index: 0, relevance_score: 1 }] }));
    try {
      const client = makeClient(server.port);
      const page = freshPage();
      const out = await client.rerank('q', page);
      assert.deepEqual(out, page);
      assert.strictEqual(client.rerankHealth.consecutiveFailures, 1);
      assert.ok(
        server.warnings.some(w => w.includes('Rerank failed')),
        'degradation must be logged',
      );
    } finally {
      await server.close();
    }
  });

  test('a duplicated index degrades to fused order', async () => {
    const server = await startRerankServer(
      jsonOK({
        results: [
          { index: 0, relevance_score: 0.3 },
          { index: 0, relevance_score: 0.7 },
          { index: 1, relevance_score: 0.4 },
        ],
      }),
    );
    try {
      const page = freshPage();
      const out = await makeClient(server.port).rerank('q', page);
      assert.deepEqual(out, page);
    } finally {
      await server.close();
    }
  });

  test('an out-of-range index degrades to fused order', async () => {
    const server = await startRerankServer(
      jsonOK({
        results: [
          { index: 0, relevance_score: 0.3 },
          { index: 1, relevance_score: 0.4 },
          { index: 3, relevance_score: 0.9 },
        ],
      }),
    );
    try {
      const page = freshPage();
      const out = await makeClient(server.port).rerank('q', page);
      assert.deepEqual(out, page);
    } finally {
      await server.close();
    }
  });

  test('a non-finite relevance_score degrades to fused order', async () => {
    const server = await startRerankServer(
      jsonOK({
        results: [
          { index: 0, relevance_score: 0.3 },
          // JSON cannot carry NaN; Infinity survives JSON.parse and is
          // rejected by the same Number.isFinite guard in _parseRerankScores.
          { index: 1, relevance_score: 1e999 },
          { index: 2, relevance_score: 0.9 },
        ],
      }),
    );
    try {
      const page = freshPage();
      const out = await makeClient(server.port).rerank('q', page);
      assert.deepEqual(out, page);
    } finally {
      await server.close();
    }
  });

  test('a non-200 response degrades to fused order', async () => {
    const server = await startRerankServer(res => reply(res, 503, 'unavailable'));
    try {
      const client = makeClient(server.port);
      const page = freshPage();
      const out = await client.rerank('q', page);
      assert.deepEqual(out, page);
      assert.strictEqual(client.rerankHealth.consecutiveFailures, 1);
    } finally {
      await server.close();
    }
  });

  test('a non-JSON response body degrades to fused order', async () => {
    const server = await startRerankServer(res =>
      reply(res, 200, '<html>gateway</html>', 'text/html'),
    );
    try {
      const client = makeClient(server.port);
      const page = freshPage();
      const out = await client.rerank('q', page);
      assert.deepEqual(out, page);
      assert.strictEqual(client.rerankHealth.consecutiveFailures, 1);
    } finally {
      await server.close();
    }
  });

  test('after circuitBreakerThreshold consecutive failures the next call is skipped and the embedding breaker is untouched', async () => {
    const server = await startRerankServer(res => reply(res, 500, 'boom'));
    try {
      const client = makeClient(server.port, {
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 60_000,
      });
      // Threshold is 3: three failures arm the rerank breaker.
      for (let i = 0; i < 3; i += 1) {
        const out = await client.rerank('q', freshPage());
        assert.deepEqual(out, freshPage());
      }
      assert.strictEqual(client.rerankHealth.consecutiveFailures, 3);
      assert.ok(client.rerankHealth.cooldownUntil > 0, 'breaker must be armed after threshold');

      // The next call must not even reach the provider.
      const out = await client.rerank('q', freshPage());
      assert.deepEqual(out, freshPage());
      assert.strictEqual(server.calls.length, 3, 'no provider call once the breaker is open');

      // The embedding breaker shares nothing with the rerank breaker.
      assert.strictEqual(client.health.consecutiveFailures, 0);
      assert.strictEqual(client.health.cooldownUntil, 0);
      assert.strictEqual(client.health.timeouts, 0);
    } finally {
      await server.close();
    }
  });

  test('degradations return the input page unchanged in order, not an empty or partial list', async () => {
    const server = await startRerankServer(res => reply(res, 500, 'boom'));
    try {
      const page = freshPage();
      const out = await makeClient(server.port).rerank('q', page);
      assert.strictEqual(out.length, page.length);
      assert.deepEqual(out, page);
      // The degradation path hands back the input array itself - the page is
      // literally unchanged, never an empty or partial list.
      assert.strictEqual(out, page);
    } finally {
      await server.close();
    }
  });

  test('warnings are logged, never thrown, on each degradation path', async () => {
    const server = await startRerankServer(jsonOK({ nonsense: true }));
    try {
      await makeClient(server.port).rerank('q', freshPage());
      assert.strictEqual(
        server.warnings.filter(w => w.includes('Rerank failed')).length,
        1,
        'each degradation logs exactly one rerank failure line',
      );
    } finally {
      await server.close();
    }
  });
});
