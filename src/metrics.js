/**
 * Signer metrics for monitoring sequence contention and inflight operations (#9).
 */

class SignerMetrics {
  constructor() {
    /** @type {Map<string, {network: string, signer: string, count: number}>} */
    this.selectedTotal = new Map();
    /** @type {Map<string, {network: string, signer: string, count: number}>} */
    this.inflight = new Map();
  }

  /** Stable composite key that avoids collision with ':' inside network names. */
  _key(network, signer) {
    return `${network}\0${signer}`;
  }

  /**
   * Record that a signer was selected for a network.
   * @param {string} network
   * @param {string} signer
   */
  recordSelection(network, signer) {
    const key = this._key(network, signer);
    const entry = this.selectedTotal.get(key) ?? { network, signer, count: 0 };
    entry.count += 1;
    this.selectedTotal.set(key, entry);
  }

  /**
   * Increment inflight count for a signer.
   * @param {string} network
   * @param {string} signer
   */
  incrementInflight(network, signer) {
    const key = this._key(network, signer);
    const entry = this.inflight.get(key) ?? { network, signer, count: 0 };
    entry.count += 1;
    this.inflight.set(key, entry);
  }

  /**
   * Decrement inflight count for a signer.
   * @param {string} network
   * @param {string} signer
   */
  decrementInflight(network, signer) {
    const key = this._key(network, signer);
    const entry = this.inflight.get(key) ?? { network, signer, count: 0 };
    entry.count = Math.max(0, entry.count - 1);
    this.inflight.set(key, entry);
  }

  /**
   * Generate Prometheus formatted metrics text.
   * @returns {string}
   */
  toPrometheusText() {
    const lines = [
      '# HELP x402_signer_selected_total Total times a signer was selected by network.',
      '# TYPE x402_signer_selected_total counter',
    ];

    for (const { network, signer, count } of this.selectedTotal.values()) {
      lines.push(`x402_signer_selected_total{network="${network}",signer="${signer}"} ${count}`);
    }

    lines.push('# HELP x402_signer_inflight Current in-flight settlements per signer.');
    lines.push('# TYPE x402_signer_inflight gauge');

    for (const { network, signer, count } of this.inflight.values()) {
      lines.push(`x402_signer_inflight{network="${network}",signer="${signer}"} ${count}`);
    }

    return lines.join('\n') + '\n';
  }
}

export const signerMetrics = new SignerMetrics();
