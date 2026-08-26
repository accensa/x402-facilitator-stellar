/**
 * Signer metrics for monitoring sequence contention and inflight operations (#9).
 */

class SignerMetrics {
  constructor() {
    /** @type {Map<string, number>} key: `${network}:${signer}` -> count */
    this.selectedTotal = new Map();
    /** @type {Map<string, number>} key: `${network}:${signer}` -> count */
    this.inflight = new Map();
  }

  /**
   * Record that a signer was selected for a network.
   * @param {string} network
   * @param {string} signer
   */
  recordSelection(network, signer) {
    const key = `${network}:${signer}`;
    const current = this.selectedTotal.get(key) || 0;
    this.selectedTotal.set(key, current + 1);
  }

  /**
   * Increment inflight count for a signer.
   * @param {string} network
   * @param {string} signer
   */
  incrementInflight(network, signer) {
    const key = `${network}:${signer}`;
    const current = this.inflight.get(key) || 0;
    this.inflight.set(key, current + 1);
  }

  /**
   * Decrement inflight count for a signer.
   * @param {string} network
   * @param {string} signer
   */
  decrementInflight(network, signer) {
    const key = `${network}:${signer}`;
    const current = this.inflight.get(key) || 0;
    this.inflight.set(key, Math.max(0, current - 1));
  }

  /**
   * Generate Prometheus formatted metrics text.
   * @returns {string}
   */
  toPrometheusText() {
    let lines = [];
    lines.push('# HELP x402_signer_selected_total Total times a signer was selected by network.');
    lines.push('# TYPE x402_signer_selected_total counter');
    for (const [key, count] of this.selectedTotal.entries()) {
      const idx = key.lastIndexOf(':');
      const network = key.substring(0, idx);
      const signer = key.substring(idx + 1);
      lines.push(`x402_signer_selected_total{network="${network}",signer="${signer}"} ${count}`);
    }

    lines.push('# HELP x402_signer_inflight Current in-flight settlements per signer.');
    lines.push('# TYPE x402_signer_inflight gauge');
    for (const [key, count] of this.inflight.entries()) {
      const idx = key.lastIndexOf(':');
      const network = key.substring(0, idx);
      const signer = key.substring(idx + 1);
      lines.push(`x402_signer_inflight{network="${network}",signer="${signer}"} ${count}`);
    }

    return lines.join('\n') + '\n';
  }
}

export const signerMetrics = new SignerMetrics();
