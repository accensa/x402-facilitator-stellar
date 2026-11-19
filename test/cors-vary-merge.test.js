import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import { createCorsHook } from '../src/cors.js';

describe('CORS Vary merge', () => {
  test('compressed cross-origin responses preserve Accept-Encoding and Origin', async () => {
    const fastify = Fastify();
    await fastify.register(fastifyCompress, { encodings: ['gzip'], threshold: 0 });

    fastify.get(
      '/supported',
      { onRequest: createCorsHook({ allowedOrigins: [] })('public') },
      async (_req, reply) => reply.send({ status: 'ok', padding: 'x'.repeat(2048) }),
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/supported',
      headers: { Origin: 'https://example.com', 'Accept-Encoding': 'gzip' },
    });

    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers.vary, 'Origin, Accept-Encoding');
    await fastify.close();
  });

  test('existing mixed-case Vary tokens are preserved and deduplicated', async () => {
    const fastify = Fastify();
    const corsHook = createCorsHook({ allowedOrigins: [] })('public');

    fastify.get(
      '/test',
      {
        onRequest: [
          async (_req, reply) => reply.header('Vary', 'Accept-Language, origin'),
          corsHook,
          corsHook,
        ],
      },
      async (_req, reply) => reply.send({ status: 'ok' }),
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: { Origin: 'https://example.com' },
    });

    assert.equal(res.headers.vary, 'Accept-Language, origin');
    await fastify.close();
  });

  test('uncompressed responses still include Vary Origin', async () => {
    const fastify = Fastify();
    fastify.get(
      '/test',
      { onRequest: createCorsHook({ allowedOrigins: [] })('public') },
      async (_req, reply) => reply.send({ status: 'ok' }),
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: { Origin: 'https://example.com' },
    });

    assert.equal(res.headers.vary, 'Origin');
    await fastify.close();
  });

  test('array-valued Vary headers are split and merged', async () => {
    const fastify = Fastify();
    const corsHook = createCorsHook({ allowedOrigins: [] })('public');

    fastify.get(
      '/test',
      {
        onRequest: [
          async (_req, reply) =>
            reply.header('Vary', ['Accept-Language', 'Origin, Accept-Encoding']),
          corsHook,
        ],
      },
      async (_req, reply) => reply.send({ status: 'ok' }),
    );

    const res = await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: { Origin: 'https://example.com' },
    });

    assert.equal(res.headers.vary, 'Accept-Language, Origin, Accept-Encoding');
    await fastify.close();
  });
});
