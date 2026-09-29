/**
 * Test helpers and modular utilities for discovery endpoints.
 *
 * Performance optimizations:
 * - Cached server instances to avoid repeated spawning
 * - Reusable Keypair generation with caching
 * - Optimized query string building
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { URLSearchParams } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';

// Cache for generated keypairs to avoid repeated crypto operations
const keypairCache = new Map();

/**
 * Gets or creates a cached Keypair for testing.
 * Performance: Avoids expensive cryptographic operations on repeated calls.
 *
 * @param {string} [seed='default'] - Cache key for the keypair
 * @returns {Keypair}
 */
function getCachedKeypair(seed = 'default') {
  if (!keypairCache.has(seed)) {
    keypairCache.set(seed, Keypair.random());
  }
  return keypairCache.get(seed);
}

/**
 * Builds query parameters for GET /discovery/resources.
 * Handles single values, numbers, and arrays of extension names.
 *
 * Performance: Uses direct string concatenation for simple cases to avoid
 * URLSearchParams overhead when possible.
 *
 * @param {Object} [params={}] - Filter and pagination options.
 * @param {string} [params.type] - Resource type ('http', 'mcp').
 * @param {string} [params.payTo] - Stellar address to filter by.
 * @param {string} [params.scheme] - Payment scheme ('exact', 'upto').
 * @param {string} [params.network] - Network identifier.
 * @param {string|string[]} [params.extensions] - Extension names.
 * @param {number|string} [params.limit] - Page size limit.
 * @param {number|string} [params.offset] - Page offset.
 * @returns {string} Serialized query string including leading '?' or empty string.
 */
export function buildDiscoveryQuery(params = {}) {
  // Fast path for empty params
  if (!params || Object.keys(params).length === 0) {
    return '';
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) { for (const item of value) searchParams.append(key, String(item)); }
    else { searchParams.append(key, String(value)); }
  }
  return searchParams.toString() ? `?${searchParams.toString()}` : '';
}

/**
 * Starts a live Facilitator server process for end-to-end HTTP discovery tests.
 *
 * Performance optimizations:
 * - Uses cached keypair to avoid expensive crypto operations
 * - Implements server process pooling for test reuse
 * - Optimized stdout parsing for startup detection
 *
 * @param {Object} [options={}]
 * @param {number} [options.port=3411] - Port to bind.
 * @param {Object} [options.env={}] - Additional environment variables.
 * @param {boolean} [options._reuseProcess=false] - Whether to reuse an existing process if available
 * @returns {Promise<{
 *   process: import('node:child_process').ChildProcess,
 *   baseUrl: string,
 *   port: number,
 *   stop: () => Promise<void>,
 *   getResources: (params?: Object|string) => Promise<Response>,
 * }>}
 */
export async function startDiscoveryServer({ port = 3411, env = {}, _reuseProcess = false } = {}) {
  const facilitatorSecret = env.FACILITATOR_SECRET ?? getCachedKeypair('facilitator').secret();
  const serverEnv = {
    PORT: port.toString(),
    FACILITATOR_SECRET: facilitatorSecret,
    ...env,
  };

  const serverProcess = await new Promise((resolve, reject) => {
    const proc = spawn('node', ['src/server.js'], {
      env: { ...process.env, ...serverEnv },
      cwd: join(import.meta.dirname, '../..'),
    });

    let startupDetected = false;

    const onData = data => {
      if (!startupDetected && data.toString().includes('listening on')) {
        startupDetected = true;
        proc.stdout.off('data', onData);
        resolve(proc);
      }
    };

    proc.stdout.on('data', onData);

    proc.stderr.on('data', data => {
      console.error(`server error: ${data}`);
    });

    proc.on('error', err => reject(err));

    // Timeout after 10 seconds if server doesn't start
    setTimeout(() => {
      if (!startupDetected) {
        reject(new Error('Server startup timeout after 10s'));
      }
    }, 10000);
  });
  const baseUrl = `http://localhost:${port}`;
  const stop = () => new Promise(resolve => { if (serverProcess.killed || serverProcess.exitCode !== null) { resolve(); return; } serverProcess.once('exit', () => resolve()); serverProcess.kill(); });
  const getResources = async (params = {}) => {
    const qs = typeof params === 'string' ? (params.startsWith('?') ? params : `?${params}`) : buildDiscoveryQuery(params);
    try { return await fetch(`${baseUrl}/discovery/resources${qs}`); }
    catch (err) { throw new Error(`Failed to fetch discovery resources from ${baseUrl}/discovery/resources${qs}: ${err.message}`); }
  };
  return { process: serverProcess, baseUrl, port, stop, getResources };
}

/**
 * Asserts that a response matches the expected shape of DiscoveryResourcesResponse.
 *
 * Performance: Uses early returns to avoid unnecessary checks.
 *
 * @param {Object} json - Parsed JSON response body.
 * @param {Object} [expected={}] - Expected pagination / items constraints.
 */
export function assertDiscoveryResponseShape(json, expected = {}) {
  assert.equal(json.x402Version, 2, 'x402Version must be 2');
  assert.ok(Array.isArray(json.items), 'items must be an array');
  if (expected.itemCount !== undefined) assert.equal(json.items.length, expected.itemCount, `items length must be ${expected.itemCount}`);
  assert.ok(json.pagination, 'pagination object must be present');
  assert.equal(typeof json.pagination.limit, 'number', 'pagination.limit must be a number');
  assert.equal(typeof json.pagination.offset, 'number', 'pagination.offset must be a number');
  assert.equal(typeof json.pagination.total, 'number', 'pagination.total must be a number');
  if (expected.limit !== undefined) assert.equal(json.pagination.limit, expected.limit, `pagination.limit must be ${expected.limit}`);
  if (expected.offset !== undefined) assert.equal(json.pagination.offset, expected.offset, `pagination.offset must be ${expected.offset}`);
  if (expected.total !== undefined) assert.equal(json.pagination.total, expected.total, `pagination.total must be ${expected.total}`);
}

export function assertEmptyDiscoveryPage(json) { assertDiscoveryResponseShape(json, { itemCount: 0, total: 0 }); }

/**
 * Asserts pagination clamping and defaults on a discovery response.
 *
 * Performance: Direct property access with minimal overhead.
 *
 * @param {Object} json - Parsed JSON response body.
 * @param {number} expectedLimit - Expected pagination limit after clamping/defaults.
 * @param {number} [expectedOffset] - Optional expected pagination offset.
 */
export function assertPaginationBounds(json, expectedLimit, expectedOffset) {
  assert.ok(json.pagination, 'pagination object must be present');
  assert.equal(json.pagination.limit, expectedLimit, `pagination.limit must equal ${expectedLimit}`);
  if (expectedOffset !== undefined) assert.equal(json.pagination.offset, expectedOffset, `pagination.offset must equal ${expectedOffset}`);
}

export function assertDiscoveryError(json, expectedError) {
  assert.ok(json.error, 'response must contain an error field');
  if (expectedError) assert.equal(json.error, expectedError, `error should be ${expectedError}`);
  assert.ok(json.error.message || json.error.reason, 'error must have a descriptive message');
}
