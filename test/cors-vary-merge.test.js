/**
 * CORS Vary header merge test for issue #677.
 * Verifies that `Vary` appends `Origin` instead of replacing it,
 * deduplicates case-insensitively, and preserves token order.
 * Compressed cross-origin responses carry both `Origin` and `Accept-Encoding`
 * in `Vary`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import { createCorsHook } from '../src/cors.js';

describe('CORS Vary merge', () => {
  test('compressed cross-origin GET /supported carries both Origin and Accept-Encoding in Vary', async _t => {
    const fastify = Fastify();

    fastify.register(fastifyCompress, { encoding: ['gzip'] });

    fastify.get(
      '/supported',
      { onRequest: createCorsHook({ allowedOrigins: [] }) },
      async (req, reply) => {
        reply.send({ status: 'ok' });
      },
    );

    await fastify.ready();

    const res = await fastify.inject({
      method: 'GET',
      url: '/supported',
      headers: {
        Origin: 'https://example.com',
        'Accept-Encoding': 'gzip',
      },
    });

    const vary = res.headers.vary;
    assert.ok(vary, 'Vary header should be present');
    const varyLower = vary.toLowerCase();
    assert.ok(varyLower.includes('origin'), 'Vary should include Origin');
    assert.ok(varyLower.includes('accept-encoding'), 'Vary should include Accept-Encoding');

    await fastify.close();
  });

  test('calling the hook twice on one reply does not duplicate the Origin token', async _t => {
    const fastify = Fastify();

    fastify.get(
      '/test',
      { onRequest: createCorsHook({ allowedOrigins: [] }) },
      async (req, reply) => {
        reply.send({ status: 'ok' });
      },
    );

    await fastify.ready();

    const res = await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: {
        Origin: 'https://example.com',
      },
    });

    const vary = res.headers.vary;
    assert.ok(vary, 'Vary header should be present');
    const matches = vary.match(/origin/gi);
    const count = matches ? matches.length : 0;
    assert.strictEqual(count, 1, 'Origin should not be duplicated in Vary');

    await fastify.close();
  });

  test('uncompressed response still says Vary: Origin', async _t => {
    const fastify = Fastify();

    fastify.get(
      '/test',
      { onRequest: createCorsHook({ allowedOrigins: [] }) },
      async (req, reply) => {
        reply.send({ status: 'ok' });
      },
    );

    await fastify.ready();

    const res = await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: {
        Origin: 'https://example.com',
      },
    });

    const vary = res.headers.vary;
    assert.strictEqual(vary, 'Origin', 'Uncompressed response should have Vary: Origin');

    await fastify.close();
  });
});
