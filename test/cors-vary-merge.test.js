/**
 * CORS Vary header merge test for issue #677.
 * Verifies that `Vary` appends `Origin` instead of replacing it, deduplicates
 * case-insensitively, and preserves token order. Compressed cross-origin
 * responses carry both `Origin` and `Accept-Encoding` in `Vary`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import { createCorsHook } from '../src/cors.js';

/** Lowercased token list of a Vary header, so spelling is not part of the contract. */
function varyTokens(header) {
  return (header ?? '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
}

describe('CORS Vary merge', () => {
  test('compressed cross-origin GET /supported carries both Origin and Accept-Encoding', async () => {
    const fastify = Fastify();
    await fastify.register(fastifyCompress, { encodings: ['gzip'], threshold: 0 });

    fastify.get(
      '/supported',
      { onRequest: createCorsHook({ allowedOrigins: [] })('public') },
      async (_req, reply) => reply.send({ status: 'ok', padding: 'x'.repeat(2048) }),
    );

    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/supported',
        headers: { Origin: 'https://example.com', 'Accept-Encoding': 'gzip' },
      });

      // Compressed, so the compression plugin writes its own Vary token after
      // this hook runs — in either order, and in its own spelling.
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.deepEqual(varyTokens(res.headers.vary).sort(), ['accept-encoding', 'origin']);
    } finally {
      await fastify.close();
    }
  });

  test('calling the hook twice on one reply does not duplicate the Origin token', async () => {
    const fastify = Fastify();
    const corsHook = createCorsHook({ allowedOrigins: [] })('public');

    fastify.get(
      '/test',
      {
        onRequest: [
          async (_req, reply) => {
            reply.header('Vary', 'Accept-Language, origin');
          },
          corsHook,
          corsHook,
        ],
      },
      async (_req, reply) => reply.send({ status: 'ok' }),
    );

    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test',
        headers: { Origin: 'https://example.com' },
      });

      // Existing tokens are preserved in order and spelling; the seeded
      // `origin` absorbs the hook's `Origin` case-insensitively.
      assert.equal(res.headers.vary, 'Accept-Language, origin');
    } finally {
      await fastify.close();
    }
  });

  test('uncompressed response still says Vary: Origin', async () => {
    const fastify = Fastify();

    fastify.get(
      '/test',
      { onRequest: createCorsHook({ allowedOrigins: [] })('public') },
      async (_req, reply) => reply.send({ status: 'ok' }),
    );

    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test',
        headers: { Origin: 'https://example.com' },
      });

      assert.equal(res.headers.vary, 'Origin');
    } finally {
      await fastify.close();
    }
  });

  test('array-valued Vary headers are split and merged', async () => {
    const fastify = Fastify();
    const corsHook = createCorsHook({ allowedOrigins: [] })('public');

    fastify.get(
      '/test',
      {
        onRequest: [
          async (_req, reply) => {
            reply.header('Vary', ['Accept-Language', 'Origin, Accept-Encoding']);
          },
          corsHook,
        ],
      },
      async (_req, reply) => reply.send({ status: 'ok' }),
    );

    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test',
        headers: { Origin: 'https://example.com' },
      });

      assert.equal(res.headers.vary, 'Accept-Language, Origin, Accept-Encoding');
    } finally {
      await fastify.close();
    }
  });
});
