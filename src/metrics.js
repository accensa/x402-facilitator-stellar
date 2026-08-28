/**
 * In-process Prometheus metrics for the facilitator.
 *
 * Hand-rolled rather than pulling in `prom-client`: the surface is six series
 * and a spike this size should not take a dependency to render a text page. The
 * registry keeps counters/histograms/gauges in Maps and renders the Prometheus
 * exposition format on demand — called by GET /metrics (or a separate
 * METRICS_PORT listener, so it need not sit on the public port).
 *
 * Series required by the operations contract:
 *   x402_requests_total{route,network,outcome,reason}
 *   x402_request_duration_seconds histogram{route,network}
 *   x402_settlements_total{network,outcome}
 *   x402_settlement_fee_stroops histogram{network}
 *   x402_rpc_retries_total{code}
 *   x402_signer_inflight{network,signer}
 */

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// The actual fee paid, in stroops (1 XLM = 10_000_000 stroops). The ceiling is
// MAX_TX_FEE_STROOPS (default 50_000), so buckets are centred on that range.
const FEE_BUCKETS = [
  1000, 5000, 10000, 25000, 50000, 75000, 100000, 250000, 500000, 1_000_000, 5_000_000,
];

function escapeLabelValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function labelKey(labels) {
  return Object.keys(labels)
    .sort()
    .map(k => `${k}=${labels[k]}`)
    .join(',');
}

/** Renders a `{name="v",...}` block for the given label objects, sorted. */
function labelString(labelNames, labels = {}) {
  if (!labelNames || labelNames.length === 0) return '';
  const parts = labelNames.map(n => `${n}="${escapeLabelValue(labels[n])}"`).join(',');
  return `{${parts}}`;
}

class Counter {
  constructor(name, help, labelNames) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.series = new Map(); // key -> { labels, value }
  }

  inc(labels = {}, value = 1) {
    const key = labelKey(labels);
    const existing = this.series.get(key);
    if (existing) existing.value += value;
    else this.series.set(key, { labels: { ...labels }, value });
  }

  render() {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    for (const { labels, value } of this.series.values()) {
      out += `${this.name}${labelString(this.labelNames, labels)} ${value}\n`;
    }
    return out;
  }
}

class Histogram {
  constructor(name, help, labelNames, buckets) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = buckets;
    this.series = new Map(); // key -> { labels, count, sum, bucketCounts[] }
  }

  observe(labels = {}, value) {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = {
        labels: { ...labels },
        count: 0,
        sum: 0,
        bucketCounts: new Array(this.buckets.length).fill(0),
      };
      this.series.set(key, s);
    }
    s.count += 1;
    s.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.bucketCounts[i] += 1;
    }
  }

  render() {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    for (const { labels, count, sum, bucketCounts } of this.series.values()) {
      const others = this.labelNames.map(n => `${n}="${escapeLabelValue(labels[n])}"`).join(',');
      for (let i = 0; i < this.buckets.length; i++) {
        const le = this.buckets[i];
        out += `${this.name}_bucket{${others}${others ? ',' : ''}le="${le}"} ${bucketCounts[i]}\n`;
      }
      out += `${this.name}_bucket{${others}${others ? ',' : ''}le="+Inf"} ${count}\n`;
      out += `${this.name}_sum{${others}} ${sum}\n`;
      out += `${this.name}_count{${others}} ${count}\n`;
    }
    return out;
  }
}

class Gauge {
  constructor(name, help, labelNames) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.series = new Map();
  }

  set(labels = {}, value) {
    const key = labelKey(labels);
    this.series.set(key, { labels: { ...labels }, value });
  }

  render() {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;
    for (const { labels, value } of this.series.values()) {
      out += `${this.name}${labelString(this.labelNames, labels)} ${value}\n`;
    }
    return out;
  }
}

/**
 * Builds the metrics registry.
 *
 * @returns {object} the registry with `.inc*` / `.observe*` / `.set*` mutators
 *   and a `.render()` that returns the full Prometheus exposition text.
 */
export function createMetrics() {
  const requests = new Counter(
    'x402_requests_total',
    'Total requests, labelled by route, network, outcome and reason.',
    ['route', 'network', 'outcome', 'reason'],
  );
  const duration = new Histogram(
    'x402_request_duration_seconds',
    'Request duration in seconds.',
    ['route', 'network'],
    DURATION_BUCKETS,
  );
  const settlements = new Counter(
    'x402_settlements_total',
    'Settlements by network and outcome (settled|failed).',
    ['network', 'outcome'],
  );
  const fee = new Histogram(
    'x402_settlement_fee_stroops',
    'Actual settlement fee paid, in stroops — the number that tells an operator whether MAX_TX_FEE_STROOPS is sane.',
    ['network'],
    FEE_BUCKETS,
  );
  const rpcRetries = new Counter(
    'x402_rpc_retries_total',
    'Soroban RPC connection-level retries by error code.',
    ['code'],
  );
  const signerInflight = new Gauge(
    'x402_signer_inflight',
    'In-flight settlements per signer — the sequence-contention signal (#9).',
    ['network', 'signer'],
  );

  return {
    incRequests: labels => requests.inc(labels),
    observeRequestDuration: ({ route, network, durationSeconds }) =>
      duration.observe({ route, network }, durationSeconds),
    incSettlements: labels => settlements.inc(labels),
    observeSettlementFee: ({ network, feeStroops }) => fee.observe({ network }, feeStroops),
    incRpcRetry: ({ code }) => rpcRetries.inc({ code: code ?? 'unknown' }),
    setSignerInflight: ({ network, signer, value }) =>
      signerInflight.set({ network, signer }, value),

    render: () =>
      [requests, duration, settlements, fee, rpcRetries, signerInflight]
        .map(m => m.render())
        .join(''),
  };
}

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
