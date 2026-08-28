/**
 * Lease-cached database credentials (#127).
 *
 * The guarantee the issue asks for: database credentials are short-lived
 * (Vault database secrets engine leases) and must be re-requested before they
 * expire, while a Vault outage must never take the service down. This manager
 * is the middle ground:
 *
 *   - credentials are fetched on demand (`fetchCredentials`) and cached;
 *   - a background tick refreshes them when the lease is within the renewal
 *     window (30% of the lease, bounded), so the pool always has fresh creds;
 *   - if a refresh fails but a cached lease is still valid, the cached
 *     credentials are returned and the outage is only logged — graceful
 *     degradation on the cached lease;
 *   - only when there is NO cached lease (Vault was down before the first
 *     successful fetch) does the fetch failure propagate.
 *
 * The password is held in memory only: it is never logged here, never written
 * to the environment, and never returned by any diagnostic surface.
 */

export function createDatabaseCredentialManager({
  fetchCredentials,
  pollIntervalMs = 10_000,
  warn = msg => console.warn(msg),
  now = () => Date.now(),
}) {
  /** @type {{username: string, password: string, leaseId: string|null, leaseDurationMs: number, expiresAtMs: number|null}|null} */
  let cached = null;
  let timer = null;
  let stopped = false;
  /** @type {Set<(creds: object) => void>} */
  const listeners = new Set();

  const emit = creds => {
    for (const listener of listeners) listener(creds);
  };

  /** How long before expiry a refresh is triggered (0 = never for static roles). */
  const refreshWindowMs = creds =>
    creds.leaseDurationMs > 0 ? Math.max(2_000, Math.min(creds.leaseDurationMs * 0.3, 60_000)) : 0;

  async function fetchOnce() {
    const fresh = await fetchCredentials();
    const leaseDurationMs = Math.max(0, Number(fresh.leaseDurationSec ?? 0) * 1000);
    cached = {
      username: fresh.username,
      password: fresh.password,
      leaseId: fresh.leaseId ?? null,
      leaseDurationMs,
      // null expiresAtMs = non-expiring (static role, lease 0): never rotated.
      expiresAtMs: leaseDurationMs > 0 ? now() + leaseDurationMs : null,
    };
    emit(cached);
    return cached;
  }

  /**
   * Returns the current credentials, refreshing first when they are within the
   * renewal window. Never throws while a cached lease exists.
   */
  async function ensureFresh() {
    if (stopped) return cached;
    if (cached) {
      const remainingMs = cached.expiresAtMs === null ? Infinity : cached.expiresAtMs - now();
      if (remainingMs > refreshWindowMs(cached)) return cached;
    }
    try {
      return await fetchOnce();
    } catch (err) {
      const remainingSec = cached
        ? cached.expiresAtMs === null
          ? 'non-expiring'
          : `${Math.max(0, Math.round((cached.expiresAtMs - now()) / 1000))}s`
        : 'none';
      warn(`[Vault] credential fetch failed (${err.message}); cached lease: ${remainingSec}`);
      if (cached) return cached;
      throw err;
    }
  }

  function start() {
    if (timer || stopped) return;
    timer = globalThis.setInterval(() => {
      void ensureFresh().catch(() => {});
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) globalThis.clearInterval(timer);
    timer = null;
  }

  /** Notifies `listener` with every freshly fetched credential (incl. the first). */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    getCredentials: ensureFresh,
    start,
    stop,
    subscribe,
  };
}
