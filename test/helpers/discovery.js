/**
 * Test helpers and modular utilities for discovery endpoints.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { URLSearchParams } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * Builds query parameters for GET /discovery/resources.
 * Handles single values, numbers, and arrays of extension names.
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
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(key, String(item));
      }
    } else {
      searchParams.append(key, String(value));
    }
  }

  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Starts a live Facilitator server process for end-to-end HTTP discovery tests.
 *
 * @param {Object} [options={}]
 * @param {number} [options.port=3411] - Port to bind.
 * @param {Object} [options.env={}] - Additional environment variables.
 * @returns {Promise<{
 *   process: import('node:child_process').ChildProcess,
 *   baseUrl: string,
 *   port: number,
 *   stop: () => Promise<void>,
 *   getResources: (params?: Object|string) => Promise<Response>,
 * }>}
 */
export async function startDiscoveryServer({ port = 3411, env = {} } = {}) {
  const facilitatorSecret = env.FACILITATOR_SECRET ?? Keypair.random().secret();
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

    proc.stdout.on('data', data => {
      if (data.toString().includes('listening on')) {
        resolve(proc);
      }
    });

    proc.stderr.on('data', data => {
      console.error(`server error: ${data}`);
    });

    proc.on('error', err => reject(err));
  });

  const baseUrl = `http://localhost:${port}`;

  const stop = () => {
    return new Promise(resolve => {
      if (serverProcess.killed || serverProcess.exitCode !== null) {
        resolve();
        return;
      }
      serverProcess.once('exit', () => resolve());
      serverProcess.kill();
    });
  };

  const getResources = async (params = {}) => {
    const qs =
      typeof params === 'string'
        ? params.startsWith('?')
          ? params
          : `?${params}`
        : buildDiscoveryQuery(params);
    return fetch(`${baseUrl}/discovery/resources${qs}`);
  };

  return {
    process: serverProcess,
    baseUrl,
    port,
    stop,
    getResources,
  };
}

/**
 * Asserts that a response matches the expected shape of DiscoveryResourcesResponse.
 *
 * @param {Object} json - Parsed JSON response body.
 * @param {Object} [expected={}] - Expected pagination / items constraints.
 */
export function assertDiscoveryResponseShape(json, expected = {}) {
  assert.equal(json.x402Version, 2, 'x402Version must be 2');
  assert.ok(Array.isArray(json.items), 'items must be an array');

  if (expected.itemCount !== undefined) {
    assert.equal(
      json.items.length,
      expected.itemCount,
      `items length must be ${expected.itemCount}`,
    );
  }

  assert.ok(json.pagination, 'pagination object must be present');
  assert.equal(typeof json.pagination.limit, 'number', 'pagination.limit must be a number');
  assert.equal(typeof json.pagination.offset, 'number', 'pagination.offset must be a number');
  assert.equal(typeof json.pagination.total, 'number', 'pagination.total must be a number');

  if (expected.limit !== undefined) {
    assert.equal(
      json.pagination.limit,
      expected.limit,
      `pagination.limit must be ${expected.limit}`,
    );
  }
  if (expected.offset !== undefined) {
    assert.equal(
      json.pagination.offset,
      expected.offset,
      `pagination.offset must be ${expected.offset}`,
    );
  }
  if (expected.total !== undefined) {
    assert.equal(
      json.pagination.total,
      expected.total,
      `pagination.total must be ${expected.total}`,
    );
  }
}

/**
 * Asserts that a response represents an empty discovery page.
 *
 * @param {Object} json - Parsed JSON response body.
 */
export function assertEmptyDiscoveryPage(json) {
  assertDiscoveryResponseShape(json, { itemCount: 0, total: 0 });
}

/**
 * Asserts pagination clamping and defaults on a discovery response.
 *
 * @param {Object} json - Parsed JSON response body.
 * @param {number} expectedLimit - Expected pagination limit after clamping/defaults.
 * @param {number} [expectedOffset] - Optional expected pagination offset.
 */
export function assertPaginationBounds(json, expectedLimit, expectedOffset) {
  assert.ok(json.pagination, 'pagination object must be present');
  assert.equal(
    json.pagination.limit,
    expectedLimit,
    `pagination.limit must equal ${expectedLimit}`,
  );
  if (expectedOffset !== undefined) {
    assert.equal(
      json.pagination.offset,
      expectedOffset,
      `pagination.offset must equal ${expectedOffset}`,
    );
  }
}
