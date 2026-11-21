import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingClient } from '../src/catalog/embeddings.js';

describe('EmbeddingClient.composeDocument fallback title fields (#779)', () => {
  const client = new EmbeddingClient('http://embeddings.test/embed');

  test('uses serviceName when present', () => {
    const doc = client.composeDocument({
      serviceName: 'Weather Forecast Service',
      toolName: 'get_forecast',
      name: 'weather',
      description: 'Hourly forecast by coordinates',
      tags: ['weather', 'climate'],
      type: 'http',
    });
    assert.equal(
      doc,
      'Weather Forecast Service. Hourly forecast by coordinates. weather climate. http',
    );
  });

  test('falls back to toolName when serviceName is absent', () => {
    const doc = client.composeDocument({
      toolName: 'search_stellar_ledger',
      description: 'Query Soroban contract events',
      tags: ['stellar', 'soroban'],
      type: 'mcp',
    });
    assert.equal(doc, 'search_stellar_ledger. Query Soroban contract events. stellar soroban. mcp');
  });

  test('falls back to name when both serviceName and toolName are absent', () => {
    const doc = client.composeDocument({
      name: 'fx-quote-feed',
      description: 'Real-time FX rates',
      tags: ['finance'],
      type: 'http',
    });
    assert.equal(doc, 'fx-quote-feed. Real-time FX rates. finance. http');
  });

  test('omits empty title cleanly and preserves extension parameters', () => {
    const doc = client.composeDocument({
      description: 'Anonymous endpoint',
      type: 'http',
      extensions: {
        bazaar: {
          parameters: {
            symbol: 'Ticker symbol',
          },
        },
      },
    });
    assert.equal(
      doc,
      'Anonymous endpoint. http. Extension bazaar parameters:. symbol: Ticker symbol',
    );
  });
});
