/**
 * Operator API for the dead-letter queue: view, replay, or discard poisoned
 * webhook messages (acceptance criterion: "Operator API allows manual replay
 * or deletion of messages").
 *
 * Registered from createApp only when a DeadLetterStore is supplied (Postgres
 * configured) — mirrors how webhooks/distributedLock are optional collaborators
 * threaded through `extras`. Every route requires a real API key
 * (requireApiKeyStrict, the same gate /usage uses) even in open mode: this
 * surface reads and mutates in-flight settlement notifications, which is not
 * data an unauthenticated caller should see or discard.
 */
import { attemptRedelivery } from './worker.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} deps
 * @param {import('./store.js').DeadLetterStore} deps.dlq
 * @param {(record: object) => Promise<unknown>} deps.publish - redelivery function
 * @param {Function} deps.requireApiKeyStrict
 * @param {Function} deps.cors
 * @param {Function} deps.preflight
 * @param {Function} deps.audit
 * @param {object} deps.retryOptions - maxDlqAttempts/baseBackoffMs, passed through to a manual replay
 */
export function registerDlqRoutes(
  app,
  { dlq, publish, requireApiKeyStrict, cors, preflight, audit, retryOptions },
) {
  /**
   * GET /admin/dlq — list dead letters, newest first.
   * Query: status (pending|exhausted|resolved|discarded), limit, offset.
   */
  app.get(
    '/admin/dlq',
    { onRequest: cors('authenticated'), preHandler: requireApiKeyStrict },
    async (req, reply) => {
      const { status } = req.query;
      const VALID_STATUSES = new Set(['pending', 'exhausted', 'resolved', 'discarded']);
      if (status && !VALID_STATUSES.has(status)) {
        return reply.code(400).send({ error: 'invalid_request', reason: 'invalid_status' });
      }

      let limit = parseInt(req.query.limit, 10);
      if (isNaN(limit)) limit = 50;
      let offset = parseInt(req.query.offset, 10);
      if (isNaN(offset)) offset = 0;

      const result = await dlq.list({ status: status ?? null, limit, offset });
      return reply.send({
        ok: true,
        items: result.items,
        pagination: { limit, offset, total: result.total },
      });
    },
  );

  /** GET /admin/dlq/:id — a single dead letter. */
  app.get(
    '/admin/dlq/:id',
    { onRequest: cors('authenticated'), preHandler: requireApiKeyStrict },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: 'invalid_request', reason: 'invalid_id' });
      }
      const row = await dlq.get(id);
      if (!row)
        return reply.code(404).send({ error: 'not_found', reason: 'dead_letter_not_found' });
      return reply.send({ ok: true, deadLetter: row });
    },
  );

  /**
   * POST /admin/dlq/:id/replay — immediate redelivery attempt, outside the
   * backoff schedule. Resolves synchronously so an operator sees the outcome
   * of the action they took rather than having to poll.
   */
  app.post(
    '/admin/dlq/:id/replay',
    { onRequest: cors('authenticated'), preHandler: requireApiKeyStrict },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: 'invalid_request', reason: 'invalid_id' });
      }
      const row = await dlq.get(id);
      if (!row)
        return reply.code(404).send({ error: 'not_found', reason: 'dead_letter_not_found' });
      if (row.status === 'discarded') {
        return reply.code(409).send({ error: 'conflict', reason: 'already_discarded' });
      }
      if (row.status === 'resolved') {
        return reply.code(409).send({ error: 'conflict', reason: 'already_resolved' });
      }

      const result = await attemptRedelivery({ dlq, row, publish, retryOptions });
      audit('dlq_replay', {
        actor: req.keyId,
        dead_letter_id: id,
        message_id: row.message_id,
        outcome: result.delivered ? 'delivered' : 'failed',
      });

      if (result.delivered) {
        return reply.send({ ok: true, status: 'resolved' });
      }
      return reply.code(502).send({ ok: false, status: 'redelivery_failed', error: result.error });
    },
  );

  /** DELETE /admin/dlq/:id — permanently discard; never retried again. */
  app.delete(
    '/admin/dlq/:id',
    { onRequest: cors('authenticated'), preHandler: requireApiKeyStrict },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: 'invalid_request', reason: 'invalid_id' });
      }
      const row = await dlq.get(id);
      if (!row)
        return reply.code(404).send({ error: 'not_found', reason: 'dead_letter_not_found' });

      await dlq.discard(id);
      audit('dlq_discard', { actor: req.keyId, dead_letter_id: id, message_id: row.message_id });
      return reply.send({ ok: true, status: 'discarded' });
    },
  );

  app.options(
    '/admin/dlq',
    { onRequest: cors('authenticated') },
    preflight('authenticated', 'GET, OPTIONS'),
  );
  app.options(
    '/admin/dlq/:id',
    { onRequest: cors('authenticated') },
    preflight('authenticated', 'GET, DELETE, OPTIONS'),
  );
  app.options(
    '/admin/dlq/:id/replay',
    { onRequest: cors('authenticated') },
    preflight('authenticated', 'POST, OPTIONS'),
  );
}
