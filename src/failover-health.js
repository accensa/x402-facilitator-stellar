/**
 * Region-aware health checker for multi-region failover (#126).
 *
 * Monitors the health of the local and remote regions. When the local region
 * becomes unhealthy (database unreachable, RPC failures), the checker signals
 * that failover should occur. When the local region recovers, it signals that
 * traffic can be routed back.
 *
 * This works alongside the existing readiness checker (src/readiness.js),
 * which handles per-RPC-host and per-signer health. This module handles the
 * regional topology dimension: which region is serving, which is degraded,
 * and whether a failover or failback should occur.
 *
 * COORDINATION MODEL
 *
 * In a multi-region deployment, each instance checks its own region's health
 * and reports to a shared coordination layer (the global database). The
 * failover-health checker provides the LOCAL view; the readiness probe
 * (GET /health/ready) exposes it; the orchestrator or global load balancer
 * makes routing decisions based on the aggregate.
 *
 * Split-brain prevention:
 *   - Each region has a unique identifier and a failover priority (lower = preferred).
 *   - Failover only occurs when the local region is UNHEALTHY (not just slow).
 *   - Recovery (failback) requires the local region to be HEALTHY for
 *     `recoveryThreshold` consecutive checks before traffic is routed back.
 *   - The checker does NOT make routing decisions itself — it only reports
 *     state. The orchestrator (DNS, load balancer, service mesh) decides.
 *
 * FAILOVER TIMING
 *
 *   detectInterval: how often to check (default: 5s)
 *   failureThreshold: consecutive failures before degraded (default: 3)
 *   recoveryThreshold: consecutive successes before recovery (default: 2)
 *
 *   Worst-case failover time = detectInterval * failureThreshold = 15s
 *   Worst-case recovery time = detectInterval * recoveryThreshold = 10s
 *   Total failover + recovery < 30s (acceptance criterion)
 */

/* globals setInterval, clearInterval, AbortSignal */

export class FailoverHealthChecker {
  /**
   * @param {object} options
   * @param {string} options.region - this instance's region (e.g. "us-east-1")
   * @param {Array<{region: string, priority: number, url?: string}>} options.regions
   *   all known regions; priority 1 = most preferred
   * @param {(url: string) => Promise<boolean>} [options.checkRemote]
   *   function to check a remote region's health (HTTP GET /healthz)
   * @param {number} [options.detectIntervalMs] - health check interval
   * @param {number} [options.failureThreshold] - consecutive failures before degraded
   * @param {number} [options.recoveryThreshold] - consecutive successes before recovery
   * @param {(msg: string) => void} [options.warn] - warning sink
   * @param {(msg: string) => void} [options.log] - info log sink
   */
  constructor({
    region,
    regions = [],
    checkRemote = defaultCheckRemote,
    detectIntervalMs = 5_000,
    failureThreshold = 3,
    recoveryThreshold = 2,
    warn = msg => console.warn(msg),
    log = () => {},
  } = {}) {
    this.region = region;
    this.regions = regions;
    this.checkRemote = checkRemote;
    this.detectIntervalMs = detectIntervalMs;
    this.failureThreshold = failureThreshold;
    this.recoveryThreshold = recoveryThreshold;
    this.warn = warn;
    this.log = log;

    /** @type {'healthy' | 'degraded' | 'recovering'} */
    this.localStatus = 'healthy';

    /** @type {Map<string, {healthy: boolean, lastCheck: number}>} */
    this.remoteStatus = new Map();

    this._localFailures = 0;
    this._localSuccesses = 0;
    this._timer = null;
    this._closed = false;
    this._onStateChange = null;
  }

  /**
   * Register a callback for state changes.
   *
   * @param {(event: {type: string, region: string, status: string, details?: object}) => void} fn
   */
  onStateChange(fn) {
    this._onStateChange = fn;
  }

  _emit(event) {
    this._onStateChange?.(event);
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._check(), this.detectIntervalMs);
    this._timer.unref?.();
    this._check();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._closed = true;
  }

  /**
   * Update local health status — called by the readiness checker or server
   * after performing its own health probes (RPC, signer, database).
   *
   * @param {boolean} healthy - whether the local region's services are reachable
   */
  reportLocalHealth(healthy) {
    if (healthy) {
      this._localFailures = 0;
      if (this.localStatus === 'degraded' || this.localStatus === 'recovering') {
        this._localSuccesses++;
        if (this._localSuccesses >= this.recoveryThreshold) {
          this.localStatus = 'healthy';
          this._localSuccesses = 0;
          this.log(`[FailoverHealth] ${this.region}: recovered (failback eligible)`);
          this._emit({ type: 'recovered', region: this.region, status: 'healthy' });
        } else {
          this.localStatus = 'recovering';
          this.log(
            `[FailoverHealth] ${this.region}: recovering (${this._localSuccesses}/${this.recoveryThreshold})`,
          );
        }
      }
    } else {
      this._localSuccesses = 0;
      this._localFailures++;

      if (this.localStatus === 'recovering') {
        // Any failure during recovery resets immediately back to degraded.
        this.localStatus = 'degraded';
        this.warn(`[FailoverHealth] ${this.region}: degraded again after failure during recovery`);
        this._emit({ type: 'degraded', region: this.region, status: 'degraded' });
      } else if (this._localFailures >= this.failureThreshold && this.localStatus === 'healthy') {
        this.localStatus = 'degraded';
        this.warn(
          `[FailoverHealth] ${this.region}: degraded after ${this._localFailures} consecutive failures`,
        );
        this._emit({ type: 'degraded', region: this.region, status: 'degraded' });
      }
    }
  }

  async _check() {
    if (this._closed) return;

    for (const remote of this.regions) {
      if (remote.region === this.region) continue;
      if (!remote.url) continue;

      try {
        const healthy = await this.checkRemote(remote.url);
        const prev = this.remoteStatus.get(remote.region);
        this.remoteStatus.set(remote.region, { healthy, lastCheck: Date.now() });

        if (prev && !prev.healthy && healthy) {
          this.log(`[FailoverHealth] remote ${remote.region}: recovered`);
          this._emit({ type: 'remote_recovered', region: remote.region, status: 'healthy' });
        } else if (prev && prev.healthy && !healthy) {
          this.warn(`[FailoverHealth] remote ${remote.region}: degraded`);
          this._emit({ type: 'remote_degraded', region: remote.region, status: 'degraded' });
        }
      } catch {
        this.remoteStatus.set(remote.region, { healthy: false, lastCheck: Date.now() });
      }
    }
  }

  /**
   * Returns the current failover state, suitable for inclusion in the
   * readiness probe response.
   *
   * @returns {object}
   */
  getState() {
    const preferredRegion = this._getPreferredRegion();
    return {
      region: this.region,
      localStatus: this.localStatus,
      failoverActive: this.localStatus === 'degraded' || this.localStatus === 'recovering',
      preferredRegion,
      remoteRegions: Object.fromEntries(
        this.regions
          .filter(r => r.region !== this.region)
          .map(r => [
            r.region,
            {
              ...this.remoteStatus.get(r.region),
              priority: r.priority,
            },
          ]),
      ),
    };
  }

  /**
   * Returns the preferred healthy region for traffic routing.
   *
   * If the local region is healthy, returns itself. If degraded or recovering,
   * returns the highest-priority (lowest number) healthy remote region.
   *
   * @returns {string} region identifier
   */
  _getPreferredRegion() {
    if (this.localStatus === 'healthy') return this.region;

    const healthyRemotes = this.regions
      .filter(r => r.region !== this.region)
      .filter(r => {
        const status = this.remoteStatus.get(r.region);
        return status?.healthy !== false; // unknown = potentially healthy
      })
      .sort((a, b) => a.priority - b.priority);

    return healthyRemotes[0]?.region ?? this.region;
  }
}

/**
 * Default remote health check: HTTP GET to the remote region's /healthz.
 *
 * @param {string} url - base URL of the remote region
 * @returns {Promise<boolean>}
 */
async function defaultCheckRemote(url) {
  try {
    const res = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
