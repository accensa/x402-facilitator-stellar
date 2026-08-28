/**
 * Toxiproxy API helper for chaos integration tests.
 *
 * Manages proxy creation/removal and toxic injection via the Toxiproxy HTTP
 * API. All operations target the default Toxiproxy endpoint on localhost:8474.
 *
 * Toxics are temporary: each cleanup() call removes all proxies, ensuring test
 * isolation.
 */
const TOXIPROXY_API = process.env.TOXIPROXY_API_URL || 'http://127.0.0.1:8474';

async function api(method, path, body) {
  const res = await fetch(`${TOXIPROXY_API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Toxiproxy API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Creates a proxy from listen address to the upstream.
 *
 * @param {string} name - Proxy name (e.g. "redis")
 * @param {string} listen - Address to listen on (e.g. "0.0.0.0:6321")
 * @param {string} upstream - Upstream address (e.g. "redis:6379")
 */
export async function createProxy(name, listen, upstream) {
  return api('POST', '/proxies', { name, listen, upstream });
}

/**
 * Adds a toxic to an existing proxy.
 *
 * @param {string} proxyName - Name of the proxy
 * @param {object} toxic - Toxic definition (name, type, attributes, stream)
 */
export async function addToxic(proxyName, toxic) {
  return api('POST', `/proxies/${proxyName}/toxics`, toxic);
}

/**
 * Removes a specific toxic from a proxy.
 */
export async function removeToxic(proxyName, toxicName) {
  return api('DELETE', `/proxies/${proxyName}/toxics/${toxicName}`);
}

/**
 * Removes all proxies — call in test cleanup to ensure isolation.
 */
export async function reset() {
  const proxies = await api('GET', '/proxies');
  for (const name of Object.keys(proxies)) {
    await api('DELETE', `/proxies/${name}`).catch(() => {});
  }
}

/**
 * Adds latency (high latency simulation) to a proxy.
 *
 * @param {string} proxyName
 * @param {number} latency - Latency in milliseconds
 * @param {string} [stream] - 'upstream', 'downstream', or undefined (both)
 */
export async function addLatency(proxyName, latency, stream) {
  return addToxic(proxyName, {
    name: `${proxyName}-latency`,
    type: 'latency',
    attributes: { latency },
    ...(stream ? { stream } : {}),
  });
}

/**
 * Adds connection reset (packet loss) to a proxy.
 *
 * @param {string} proxyName
 * @param {number} [timeout] - Timeout in ms before reset (default: instant)
 */
export async function addConnectionReset(proxyName, timeout = 0) {
  return addToxic(proxyName, {
    name: `${proxyName}-reset`,
    type: 'reset_peer',
    attributes: { timeout },
  });
}

/**
 * Adds bandwidth throttle (limit data rate) to a proxy.
 *
 * @param {string} proxyName
 * @param {number} rate - Bytes per second
 * @param {string} [stream] - 'upstream', 'downstream', or undefined (both)
 */
export async function addBandwidthThrottle(proxyName, rate, stream) {
  return addToxic(proxyName, {
    name: `${proxyName}-bandwidth`,
    type: 'bandwidth',
    attributes: { rate },
    ...(stream ? { stream } : {}),
  });
}

/**
 * Adds a timeout (connection timeout / socket timeout) to a proxy.
 *
 * @param {string} proxyName
 * @param {number} timeout - Timeout in milliseconds
 * @param {string} [stream] - 'upstream', 'downstream', or undefined (both)
 */
export async function addTimeout(proxyName, timeout, stream) {
  return addToxic(proxyName, {
    name: `${proxyName}-timeout`,
    type: 'timeout',
    attributes: { timeout },
    ...(stream ? { stream } : {}),
  });
}

/**
 * Adds a limit_data toxic that closes the connection after N bytes.
 * Simulates truncated transfers / incomplete reads.
 *
 * @param {string} proxyName
 * @param {number} bytes - Maximum bytes before connection close
 * @param {string} [stream]
 */
export async function addLimitData(proxyName, bytes, stream) {
  return addToxic(proxyName, {
    name: `${proxyName}-limit-data`,
    type: 'limit_data',
    attributes: { bytes },
    ...(stream ? { stream } : {}),
  });
}

/**
 * Adds a slow_close toxic that delays socket close.
 *
 * @param {string} proxyName
 * @param {number} duration - Delay in milliseconds
 * @param {string} [stream]
 */
export async function addSlowClose(proxyName, duration, stream) {
  return addToxic(proxyName, {
    name: `${proxyName}-slow-close`,
    type: 'slow_close',
    attributes: { duration },
    ...(stream ? { stream } : {}),
  });
}

/**
 * Slices a proxy's toxic list and returns just the names.
 */
export async function listToxics(proxyName) {
  const proxy = await api('GET', `/proxies/${proxyName}`);
  return (proxy.toxics || []).map(t => t.name);
}

export { api, TOXIPROXY_API };
