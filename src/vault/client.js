/**
 * Thin wrapper over node-vault (the canonical Node.js client for HashiCorp
 * Vault) for exactly the two operations this service needs (#127):
 *
 *   1. AppRole login — machine identity, role_id + secret_id in, short-lived
 *      client token out. The token itself is a lease: it is refreshed before
 *      expiry, and a failed read that looks like an expired token triggers one
 *      re-login and retry.
 *   2. Reading dynamic database credentials (`<mount>/creds/<role>`), which
 *      returns a username/password pair with its own lease.
 *
 * Secrets never leave this module through logs or the environment: the
 * database password is returned to the credential manager, which holds it in
 * memory only.
 */

/** node-vault surfaces HTTP errors as err.response.statusCode (403 = token expired/denied). */
function isAuthFailure(err) {
  return err?.response?.statusCode === 403;
}

export function createVaultClient({
  address,
  namespace,
  roleId,
  secretId,
  nodeVault,
  now = () => Date.now(),
}) {
  const client = nodeVault({ endpoint: address, apiVersion: 'v1', namespace });
  let token = null;
  let tokenExpiresAtMs = 0;

  async function ensureToken() {
    if (token && now() < tokenExpiresAtMs) return token;
    const res = await client.approleLogin({ role_id: roleId, secret_id: secretId });
    token = res?.auth?.client_token;
    if (!token) throw new Error('AppRole login succeeded without a client token');
    // Relog before the token lease lapses; floor at 30s so a pathological
    // zero-length lease cannot cause a login storm.
    const ttlSec = Math.max(30, Number(res?.auth?.lease_duration ?? 300));
    tokenExpiresAtMs = now() + ttlSec * 1000;
    client.token = token;
    return token;
  }

  async function doRead({ mount, role }) {
    const res = await client.read(`${mount}/creds/${role}`);
    if (!res?.data?.username || !res?.data?.password) {
      throw new Error(`Vault returned no credentials for ${mount}/creds/${role}`);
    }
    return {
      username: res.data.username,
      password: res.data.password,
      leaseId: res.lease_id ?? null,
      leaseDurationSec: Number(res.lease_duration ?? 0),
      renewable: Boolean(res.renewable),
    };
  }

  return {
    /**
     * Reads dynamic database credentials, re-authenticating once if the
     * AppRole token lapsed between the check and the read.
     *
     * @param {object} [options]
     * @param {string} [options.mount] - database secrets engine mount path
     * @param {string} options.role - database role name
     */
    async readDatabaseCredentials({ mount = 'database', role }) {
      await ensureToken();
      try {
        return await doRead({ mount, role });
      } catch (err) {
        if (isAuthFailure(err)) {
          token = null;
          tokenExpiresAtMs = 0;
          await ensureToken();
          return await doRead({ mount, role });
        }
        throw err;
      }
    },
  };
}
