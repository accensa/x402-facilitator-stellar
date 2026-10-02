/**
 * Shared Redis connection factory.
 *
 * Two subsystems need Redis and neither should own the connection logic:
 * `RedisRateLimiter` (#94) shares rate-limit buckets across replicas, and the
 * catalog search cache (#392) shares cached discovery results. Both want the
 * same three properties:
 *
 *   1. **Never fatal at boot.** ioredis is imported lazily so a deployment with
 *      no Redis installed still starts, and a bad `REDIS_URL` degrades to
 *      in-process behaviour rather than crash-looping the pod.
 *   2. **Warn once per outage.** An unreachable Redis produces a steady stream
 *      of failed operations; the operator wants one line, not one per request.
 *   3. **Recover quietly.** The `'ready'` event clears the degraded flag so a
 *      reconnect is not a silent surprise.
 *
 * The caller keeps ownership of the degrade/recover *policy* (what falling back
 * means differs between a rate limiter and a cache); this module only owns
 * establishing the connection and reporting readiness transitions.
 */

/**
 * @typedef {object} RedisConnection
 * @property {object|null} client - the ioredis-compatible client, or null when
 *   no URL was configured and none was injected
 * @property {boolean} external - true when the caller supplied the client, so
 *   this process must not close it on shutdown
 * @property {string|null} redisUrl
 * @property {() => void} onDegrade - call when an operation failed
 * @property {() => void} onRecover - call when the connection came back
 * @property {() => boolean} isUsable - false once degraded or ended
 * @property {() => object|null} getClient - the live client, for the `status`
 *   check callers make before using it
 * @property {Promise<object|null>} ready - resolves once the lazy import
 *   settles; tests can await this instead of sleeping
 */

/**
 * Creates a lazily-connected Redis handle.
 *
 * @param {object} options
 * @param {object} [options.client] - an ioredis-compatible client, injected in
 *   tests. When given, no import happens and the client is never closed here.
 * @param {string|null} [options.redisUrl] - redis:// URL. Null means "no Redis
 *   configured", which is a supported deployment (single instance).
 * @param {(message: string) => void} [options.onEvent] - receives
 *   `{type: 'degraded'|'recovered'|'unavailable', message}`. The caller formats
 *   its own log line, so the prefix (`[RateLimit]`, `[CatalogCache]`) stays with
 *   the subsystem that knows the consequence.
 * @returns {RedisConnection}
 */
/**
 * Creates a lazily-connected Redis handle.
 *
 * @param {object} options
 * @param {object} [options.client] - an ioredis-compatible client, injected in
 *   tests. When given, no import happens and the client is never closed here.
 * @param {string|null} [options.redisUrl] - redis:// URL. Null means "no Redis
 *   configured", which is a supported deployment (single instance).
 * @param {(event: {type: 'degraded'|'recovered'|'unavailable', message: string}) => void} [options.onEvent]
 *   receives readiness transitions; the caller formats its own log line.
 * @returns {RedisConnection}
 */
export function createRedisConnection({ client, redisUrl = null, onEvent = () => {} } = {}) {
  let redis = client ?? null;
  const external = Boolean(client);
  let degraded = false;
  let ended = false;

  const emitDegraded = message => {
    if (degraded) return;
    degraded = true;
    onEvent({ type: 'degraded', message });
  };
  const emitRecovered = () => {
    if (!degraded) return;
    degraded = false;
    onEvent({ type: 'recovered', message: 'Redis reconnected' });
  };

  const ready = (async () => {
    if (redis) return redis;
    if (!redisUrl) return null;
    try {
      const { default: Redis } = await import('ioredis');
      redis = new Redis(redisUrl);
      redis.on('error', err => emitDegraded(`Redis error: ${err.message}`));
      redis.on('ready', () => emitRecovered());
      redis.on('end', () => {
        ended = true;
      });
      return redis;
    } catch (err) {
      onEvent({ type: 'unavailable', message: `Redis unavailable (${err.message})` });
      return null;
    }
  })();

  return {
    get client() {
      return redis;
    },
    external,
    redisUrl,
    onDegrade: emitDegraded,
    onRecover: emitRecovered,
    isUsable: () => Boolean(redis) && !degraded && !ended && redis.status !== 'end',
    getClient: () => (degraded || ended ? null : redis),
    ready,
  };
}

export default createRedisConnection;
