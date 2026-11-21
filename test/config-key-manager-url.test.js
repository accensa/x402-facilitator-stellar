/**
 * @file config-key-manager-url.test.js
 * @description Boot-time validation of the remote key-source URL (#675).
 *
 * `KEY_MANAGER_URL` decides which keys sign settlements, so a plaintext or
 * mistyped URL is a money question. These tests pin the rules `resolveConfig`
 * enforces before the first fetch: absolute http(s) only, no embedded
 * userinfo, https outside development/test, and an optional host allowlist
 * with dot-boundary matching. Both the testnet and pubnet variables are
 * covered, since the pubnet branch falls back to the testnet value.
 *
 * All tests are synchronous and offline — `resolveConfig` takes env as an
 * argument.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, TESTNET, PUBNET } from '../src/config.js';

// Real ed25519 seeds: resolveConfig validates every signer secret with a
// checksum-aware StrKey decode (#498), so placeholder strings cannot be used.
const SECRET_1 = 'SAO2MAIQCR5T27QDICO3QJTD2YZ4PMEAVLCLQ6AANVGPCZ53TEACPDOQ';
const SECRET_2 = 'SDKL5BFVNLUCIP64CY3ZXSEAOQYJ7YNG35OKBFUW5QEZNZRKV6Q5DER6';

function resolveWith(extra = {}) {
  return resolveConfig({ FACILITATOR_SECRET: SECRET_1, ...extra });
}

/** A minimal pubnet-enabled env, so the pubnet branch is exercised for real. */
function resolvePubnetWith(extra = {}) {
  return resolveConfig({
    FACILITATOR_SECRET: SECRET_1,
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: SECRET_2,
    STELLAR_RPC_URL_PUBNET: 'https://rpc.example.com',
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Shape: absolute, http(s), no userinfo — both networks
// ---------------------------------------------------------------------------

test('KEY_MANAGER_URL: a non-http(s) scheme throws, naming the variable', () => {
  assert.throws(
    () => resolveWith({ KEY_MANAGER_URL: 'ftp://vault.example.com/keys' }),
    /KEY_MANAGER_URL must use http or https/,
  );
});

test('KEY_MANAGER_URL: a relative path throws, naming the variable', () => {
  assert.throws(
    () => resolveWith({ KEY_MANAGER_URL: '/v1/x402/signers' }),
    /KEY_MANAGER_URL must be an absolute URL/,
  );
  assert.throws(
    () => resolveWith({ KEY_MANAGER_URL: 'vault.example.com/keys' }),
    /KEY_MANAGER_URL must be an absolute URL/,
  );
});

test('KEY_MANAGER_URL: embedded userinfo throws, and the secret is not echoed', () => {
  const password = 'hunter2-should-not-leak';
  assert.throws(
    () => resolveWith({ KEY_MANAGER_URL: `https://user:${password}@vault.example.com/keys` }),
    error => {
      assert.match(error.message, /KEY_MANAGER_URL must not embed credentials/);
      assert.doesNotMatch(error.message, new RegExp(password));
      assert.match(error.message, /vault\.example\.com/);
      return true;
    },
  );
});

test('KEY_MANAGER_URL: https is accepted and stored trimmed', () => {
  const config = resolveWith({
    KEY_MANAGER_URL: '  https://vault.example.com/v1/x402/signers  ',
  });
  assert.equal(
    config.perNetwork[TESTNET].keyManagerUrl,
    'https://vault.example.com/v1/x402/signers',
  );
});

test('KEY_MANAGER_URL: unset and blank both resolve to null', () => {
  assert.equal(resolveWith().perNetwork[TESTNET].keyManagerUrl, null);
  assert.equal(resolveWith({ KEY_MANAGER_URL: '   ' }).perNetwork[TESTNET].keyManagerUrl, null);
});

// ---------------------------------------------------------------------------
// https outside development/test
// ---------------------------------------------------------------------------

test('KEY_MANAGER_URL: http throws under NODE_ENV=production', () => {
  assert.throws(
    () =>
      resolveWith({
        NODE_ENV: 'production',
        KEY_MANAGER_URL: 'http://vault.example.com/keys',
      }),
    /KEY_MANAGER_URL must use https when NODE_ENV=production/,
  );
});

test('KEY_MANAGER_URL: http is accepted under NODE_ENV=test and development', () => {
  // test/config.test.js keeps http fixtures under these environments; the
  // production rule must not reach them.
  for (const NODE_ENV of ['test', 'development']) {
    const config = resolveWith({ NODE_ENV, KEY_MANAGER_URL: 'http://keymanager:8080' });
    assert.equal(config.perNetwork[TESTNET].keyManagerUrl, 'http://keymanager:8080');
  }
  // Unset NODE_ENV resolves to the development default, so the existing
  // fixtures keep passing unchanged.
  assert.equal(
    resolveWith({ KEY_MANAGER_URL: 'http://keymanager:8080' }).perNetwork[TESTNET].keyManagerUrl,
    'http://keymanager:8080',
  );
});

// ---------------------------------------------------------------------------
// Host allowlist
// ---------------------------------------------------------------------------

test('KEY_MANAGER_ALLOWED_HOSTS: unset accepts any https host', () => {
  const config = resolveWith({ KEY_MANAGER_URL: 'https://anywhere.example.com/keys' });
  assert.equal(config.perNetwork[TESTNET].keyManagerUrl, 'https://anywhere.example.com/keys');
});

test('KEY_MANAGER_ALLOWED_HOSTS: an unlisted host is rejected', () => {
  assert.throws(
    () =>
      resolveWith({
        KEY_MANAGER_URL: 'https://vault.example.com/keys',
        KEY_MANAGER_ALLOWED_HOSTS: 'keys.internal',
      }),
    /KEY_MANAGER_URL host "vault\.example\.com" is not listed in KEY_MANAGER_ALLOWED_HOSTS/,
  );
});

test('KEY_MANAGER_ALLOWED_HOSTS: a listed host is accepted, with or without a port', () => {
  for (const url of [
    'https://vault.example.com/keys',
    'https://vault.example.com:8443/keys',
    'https://VAULT.Example.com/keys',
  ]) {
    const config = resolveWith({
      KEY_MANAGER_URL: url,
      KEY_MANAGER_ALLOWED_HOSTS: ' example.com ',
    });
    assert.equal(config.perNetwork[TESTNET].keyManagerUrl, url);
  }
});

test('KEY_MANAGER_ALLOWED_HOSTS: a listed host covers its subdomains', () => {
  const config = resolveWith({
    KEY_MANAGER_URL: 'https://vault.example.com/keys',
    KEY_MANAGER_ALLOWED_HOSTS: 'example.com',
  });
  assert.equal(config.perNetwork[TESTNET].keyManagerUrl, 'https://vault.example.com/keys');
});

test('KEY_MANAGER_ALLOWED_HOSTS: dot-boundary matching never accepts evil-example.com', () => {
  // The failure this guards: a substring match would let an attacker-controlled
  // lookalike domain supply the signer set.
  assert.throws(
    () =>
      resolveWith({
        KEY_MANAGER_URL: 'https://evil-example.com/keys',
        KEY_MANAGER_ALLOWED_HOSTS: 'example.com',
      }),
    /is not listed in KEY_MANAGER_ALLOWED_HOSTS/,
  );
});

test('KEY_MANAGER_ALLOWED_HOSTS: multiple entries are a trimmed, comma-separated list', () => {
  const config = resolveWith({
    KEY_MANAGER_URL: 'https://b.internal/keys',
    KEY_MANAGER_ALLOWED_HOSTS: 'a.internal, b.internal ,',
  });
  assert.equal(config.perNetwork[TESTNET].keyManagerUrl, 'https://b.internal/keys');
});

// ---------------------------------------------------------------------------
// Pubnet branch
// ---------------------------------------------------------------------------

test('KEY_MANAGER_URL_PUBNET: the same shape rules apply, naming the pubnet variable', () => {
  assert.throws(
    () => resolvePubnetWith({ KEY_MANAGER_URL_PUBNET: 'ftp://vault.example.com/keys' }),
    /KEY_MANAGER_URL_PUBNET must use http or https/,
  );
  assert.throws(
    () => resolvePubnetWith({ KEY_MANAGER_URL_PUBNET: '/v1/x402/signers-pubnet' }),
    /KEY_MANAGER_URL_PUBNET must be an absolute URL/,
  );
  assert.throws(
    () =>
      resolvePubnetWith({
        KEY_MANAGER_URL_PUBNET: 'https://user:pass@vault.example.com/keys',
      }),
    /KEY_MANAGER_URL_PUBNET must not embed credentials/,
  );
});

test('KEY_MANAGER_URL_PUBNET: http throws under NODE_ENV=production', () => {
  assert.throws(
    () =>
      resolvePubnetWith({
        NODE_ENV: 'production',
        KEY_MANAGER_URL_PUBNET: 'http://vault.example.com/keys',
      }),
    /KEY_MANAGER_URL_PUBNET must use https when NODE_ENV=production/,
  );
});

test('KEY_MANAGER_URL_PUBNET: the allowlist applies to the pubnet URL', () => {
  assert.throws(
    () =>
      resolvePubnetWith({
        KEY_MANAGER_URL_PUBNET: 'https://unlisted.internal/keys',
        KEY_MANAGER_ALLOWED_HOSTS: 'example.com',
      }),
    /KEY_MANAGER_URL_PUBNET host "unlisted\.internal" is not listed/,
  );
  assert.throws(
    () =>
      resolvePubnetWith({
        KEY_MANAGER_URL_PUBNET: 'https://evil-example.com/keys',
        KEY_MANAGER_ALLOWED_HOSTS: 'example.com',
      }),
    /is not listed in KEY_MANAGER_ALLOWED_HOSTS/,
  );

  const config = resolvePubnetWith({
    KEY_MANAGER_URL_PUBNET: 'https://vault.example.com/keys',
    KEY_MANAGER_ALLOWED_HOSTS: 'example.com',
  });
  assert.equal(config.perNetwork[PUBNET].keyManagerUrl, 'https://vault.example.com/keys');
});

test('KEY_MANAGER_URL_PUBNET: falls back to KEY_MANAGER_URL, and that value is validated', () => {
  const config = resolvePubnetWith({ KEY_MANAGER_URL: 'https://vault.example.com/keys' });
  assert.equal(config.perNetwork[PUBNET].keyManagerUrl, 'https://vault.example.com/keys');

  // The error names the variable that actually supplied the value, not the
  // empty pubnet one — otherwise the operator edits the wrong line.
  assert.throws(
    () =>
      resolvePubnetWith({
        NODE_ENV: 'production',
        KEY_MANAGER_URL: 'http://vault.example.com/keys',
      }),
    /KEY_MANAGER_URL must use https when NODE_ENV=production/,
  );
});

test('KEY_MANAGER_URL_PUBNET: unset on both networks resolves to null', () => {
  const config = resolvePubnetWith();
  assert.equal(config.perNetwork[TESTNET].keyManagerUrl, null);
  assert.equal(config.perNetwork[PUBNET].keyManagerUrl, null);
});
