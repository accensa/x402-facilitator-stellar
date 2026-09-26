import test from 'node:test';
import assert from 'node:assert';
import { resolveConfig, TESTNET, PUBNET } from '../src/config.js';

test('resolveConfig: testnet only by default', () => {
  const env = { FACILITATOR_SECRET: 'S123' };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.networks, [TESTNET]);
  assert.ok(config.perNetwork[TESTNET]);
  assert.strictEqual(config.perNetwork[TESTNET].secret, 'S123');
  assert.strictEqual(config.perNetwork[TESTNET].maxTransactionFeeStroops, 50000);
});

test('resolveConfig: nodeEnv defaults to development', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.nodeEnv, 'development');
  assert.strictEqual(
    resolveConfig({ FACILITATOR_SECRET: 'S123', NODE_ENV: 'production' }).nodeEnv,
    'production',
  );
});

test('resolveConfig: CORS origins are a trimmed comma-separated list', () => {
  const config = resolveConfig({
    FACILITATOR_SECRET: 'S123',
    CORS_ALLOWED_ORIGINS: ' https://a.example , https://b.example ,',
  });
  assert.deepStrictEqual(config.cors.allowedOrigins, ['https://a.example', 'https://b.example']);

  const empty = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.deepStrictEqual(empty.cors.allowedOrigins, []);
});

test('resolveConfig: requires secret', () => {
  assert.throws(() => resolveConfig({}), /FACILITATOR_SECRET is required/);
  assert.throws(() => resolveConfig({ FACILITATOR_SECRET: 'G123' }), /starts with S/);
});

test('resolveConfig: pubnet requires its own secret', () => {
  const env = { FACILITATOR_SECRET: 'S123', ENABLE_PUBNET: 'true' };
  assert.throws(() => resolveConfig(env), /FACILITATOR_SECRET_PUBNET is required/);
});

test('resolveConfig: pubnet requires its own RPC URL', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
  };
  assert.throws(() => resolveConfig(env), /STELLAR_RPC_URL_PUBNET is unset/);
});

test('resolveConfig: pubnet sets per-network values correctly', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    STELLAR_RPC_URL: 'https://testnet.local',
    MAX_TX_FEE_STROOPS: '10000',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
    MAX_TX_FEE_STROOPS_PUBNET: '20000',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.networks, [TESTNET, PUBNET]);

  assert.strictEqual(config.perNetwork[TESTNET].secret, 'S123');
  assert.strictEqual(config.perNetwork[TESTNET].rpcUrl, 'https://testnet.local');
  assert.strictEqual(config.perNetwork[TESTNET].maxTransactionFeeStroops, 10000);

  assert.strictEqual(config.perNetwork[PUBNET].secret, 'S456');
  assert.strictEqual(config.perNetwork[PUBNET].rpcUrl, 'https://pubnet.local');
  assert.strictEqual(config.perNetwork[PUBNET].maxTransactionFeeStroops, 20000);
});

test('resolves custom rate limits from RATE_LIMIT_GLOBAL and RATE_LIMIT_<key>', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    FACILITATOR_API_KEYS: 'admin:secret123, user:secret456',
    RATE_LIMIT_GLOBAL:
      'verify_rpm=100,settle_rpm=10,settle_rph=50,settle_rpd=500,fee_spd=1000,catalog_rpm=5',
    RATE_LIMIT_admin: 'verify_rpm=1000,fee_spd=2000,catalog_rpm=50',
  };
  const config = resolveConfig(env);
  assert.equal(config.rateLimits.global.verifyRpm, 100);
  assert.equal(config.rateLimits.global.settleRph, 50);
  assert.equal(config.rateLimits.global.catalogRpm, 5);

  // Key ids are normalized to uppercase (the auth layer uppercases req.keyId,
  // so per-key limits are keyed by the normalized id).
  assert.equal(config.rateLimits.keys.ADMIN.verifyRpm, 1000);
  assert.equal(config.rateLimits.keys.ADMIN.catalogRpm, 50);
  // Unspecified per-key limits fall back to global
  assert.equal(config.rateLimits.keys.ADMIN.settleRph, 100);
});

test('resolveConfig: PORT defaults to 3402 when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.port, 3402);
});

test('resolveConfig: rpcForceIpv4 defaults to true and parses RPC_FORCE_IPV4', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  assert.strictEqual(resolveConfig(base).rpcForceIpv4, true);
  assert.strictEqual(resolveConfig({ ...base, RPC_FORCE_IPV4: 'false' }).rpcForceIpv4, false);
  assert.strictEqual(resolveConfig({ ...base, RPC_FORCE_IPV4: 'true' }).rpcForceIpv4, true);
});

test('resolveConfig: PORT rejects non-numeric and out-of-range values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  for (const bad of ['abc', '12.5', '-1', '0', '65536', '']) {
    assert.throws(
      () => resolveConfig({ ...base, PORT: bad }),
      /PORT must be a finite integer between 1 and 65535/,
      `PORT=${JSON.stringify(bad)} should throw`,
    );
  }
});

test('resolveConfig: PORT accepts range boundary values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  assert.strictEqual(resolveConfig({ ...base, PORT: '1' }).port, 1);
  assert.strictEqual(resolveConfig({ ...base, PORT: '65535' }).port, 65535);
});

test('resolveConfig: MAX_TX_FEE_STROOPS defaults to 50000 when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.perNetwork[TESTNET].maxTransactionFeeStroops, 50000);
});

test('resolveConfig: MAX_TX_FEE_STROOPS rejects non-numeric and out-of-range values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  for (const bad of ['abc', '12.5', '-100', '0', '99', '10000001']) {
    assert.throws(
      () => resolveConfig({ ...base, MAX_TX_FEE_STROOPS: bad }),
      /MAX_TX_FEE_STROOPS must be a finite integer between 100 and 10000000/,
      `MAX_TX_FEE_STROOPS=${JSON.stringify(bad)} should throw`,
    );
  }
});

test('resolveConfig: MAX_TX_FEE_STROOPS accepts range boundary values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  assert.strictEqual(
    resolveConfig({ ...base, MAX_TX_FEE_STROOPS: '100' }).perNetwork[TESTNET]
      .maxTransactionFeeStroops,
    100,
  );
  assert.strictEqual(
    resolveConfig({ ...base, MAX_TX_FEE_STROOPS: '10000000' }).perNetwork[TESTNET]
      .maxTransactionFeeStroops,
    10000000,
  );
});

test('resolveConfig: MAX_TX_FEE_STROOPS_PUBNET defaults to 50000 when unset', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[PUBNET].maxTransactionFeeStroops, 50000);
});

test('resolveConfig: MAX_TX_FEE_STROOPS_PUBNET rejects non-numeric and out-of-range values', () => {
  const base = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
  };
  for (const bad of ['abc', '12.5', '-100', '0', '99', '10000001']) {
    assert.throws(
      () => resolveConfig({ ...base, MAX_TX_FEE_STROOPS_PUBNET: bad }),
      /MAX_TX_FEE_STROOPS_PUBNET must be a finite integer between 100 and 10000000/,
      `MAX_TX_FEE_STROOPS_PUBNET=${JSON.stringify(bad)} should throw`,
    );
  }
});

// NEW TESTS FOR MISSING COVERAGE

test('resolveConfig: handles FEE_BUMP_SECRET correctly', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    FEE_BUMP_SECRET: 'S999',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[TESTNET].feeBumpSecret, 'S999');
});

test('resolveConfig: handles FEE_BUMP_SECRET_PUBNET correctly', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
    FEE_BUMP_SECRET_PUBNET: 'S888',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[PUBNET].feeBumpSecret, 'S888');
});

test('resolveConfig: handles FACILITATOR_SECRETS (plural) correctly', () => {
  const env = {
    FACILITATOR_SECRETS: 'S123,S456,S789',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.perNetwork[TESTNET].secrets, ['S123', 'S456', 'S789']);
  assert.strictEqual(config.perNetwork[TESTNET].secret, 'S123'); // first secret
});

test('resolveConfig: handles FACILITATOR_SECRETS_PUBNET (plural) correctly', () => {
  const env = {
    FACILITATOR_SECRET: 'S123', // Need testnet secret too
    FACILITATOR_SECRETS_PUBNET: 'S111,S222,S333',
    ENABLE_PUBNET: 'true',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.perNetwork[PUBNET].secrets, ['S111', 'S222', 'S333']);
  assert.strictEqual(config.perNetwork[PUBNET].secret, 'S111'); // first secret
});

test('resolveConfig: rejects duplicate secret keys in FACILITATOR_SECRET', () => {
  const env = {
    FACILITATOR_SECRET: 'S123,S123',
  };
  assert.throws(() => resolveConfig(env), /Duplicate secret key found/);
});

test('resolveConfig: rejects duplicate secret keys in FACILITATOR_SECRETS', () => {
  const env = {
    FACILITATOR_SECRETS: 'S123,S456,S123',
  };
  assert.throws(() => resolveConfig(env), /Duplicate secret key found/);
});

test('resolveConfig: validates API key IDs are alphanumeric and underscore only', () => {
  const base = { FACILITATOR_SECRET: 'S123' };

  // Valid key IDs
  assert.doesNotThrow(() =>
    resolveConfig({
      ...base,
      FACILITATOR_API_KEYS: 'valid_key:secret123,anotherKey:secret456',
    }),
  );

  // Invalid key IDs
  assert.throws(
    () =>
      resolveConfig({
        ...base,
        FACILITATOR_API_KEYS: 'invalid-key:secret123', // hyphen not allowed
      }),
    /API key id \"invalid-key\" contains invalid characters/,
  );

  assert.throws(
    () =>
      resolveConfig({
        ...base,
        FACILITATOR_API_KEYS: 'invalid key:secret123', // space not allowed
      }),
    /API key id \"invalid key\" contains invalid characters/,
  );
});

test('resolveConfig: parses API keys without explicit ID (uses index-based IDs)', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    FACILITATOR_API_KEYS: 'secret1,secret2,secret3',
  };
  const config = resolveConfig(env);
  // Should create keys with IDs key_0, key_1, key_2
  assert.strictEqual(config.apiKeys.length, 3);
  assert.strictEqual(config.apiKeys[0].id, 'key_0');
  assert.strictEqual(config.apiKeys[1].id, 'key_1');
  assert.strictEqual(config.apiKeys[2].id, 'key_2');
});

test('resolveConfig: throws when RATE_LIMIT_ key references non-existent API key', () => {
  const base = {
    FACILITATOR_SECRET: 'S123',
    FACILITATOR_API_KEYS: 'existing:secret123',
  };
  assert.throws(
    () =>
      resolveConfig({
        ...base,
        RATE_LIMIT_nonexistent: 'verify_rpm=100',
      }),
    /RATE_LIMIT_nonexistent is configured but no API key with id \"nonexistent\" exists/,
  );
});

test('resolveConfig: handles TRUST_PROXY as numeric hop count', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    TRUST_PROXY: '1',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.trustProxy, 1);
});

test('resolveConfig: handles TRUST_PROXY as comma-separated list', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    TRUST_PROXY: '1.2.3.4, 1.2.3.5, loopback',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.trustProxy, ['1.2.3.4', '1.2.3.5', 'loopback']);
});

test('resolveConfig: rejects TRUST_PROXY with boolean values', () => {
  const base = { FACILITATOR_SECRET: 'S123' };
  for (const value of ['true', 'false', 'yes', 'no', 'TRUE', 'FALSE']) {
    assert.throws(
      () =>
        resolveConfig({
          ...base,
          TRUST_PROXY: value,
        }),
      /TRUST_PROXY must be a hop count, a comma-separated proxy list, or an Express preset/,
    );
  }
});

test('resolveConfig: handles IP_HASH_SECRET', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    IP_HASH_SECRET: 'custom-secret-123',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.ipHashSecret, 'custom-secret-123');
});

test('resolveConfig: handles IP_HASH_SECRET as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.ipHashSecret, null);
});

test('resolveConfig: handles REDIS_URL', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    REDIS_URL: 'redis://localhost:6379',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.redisUrl, 'redis://localhost:6379');
});

test('resolveConfig: handles REDIS_URL as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.redisUrl, null);
});

test('resolveConfig: handles REDIS_NODES', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    REDIS_NODES: 'redis1:6379, redis2:6379, redis3:6379',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.redisNodes, ['redis1:6379', 'redis2:6379', 'redis3:6379']);
});

test('resolveConfig: handles REDIS_NODES as empty array when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.deepStrictEqual(config.redisNodes, []);
});

test('resolveConfig: handles DATABASE_URL', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.databaseUrl, 'postgres://user:pass@localhost:5432/db');
});

test('resolveConfig: handles DATABASE_URL as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.databaseUrl, null);
});

test('resolveConfig: handles DATABASE_URL_REPLICA', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    DATABASE_URL_REPLICA: 'postgres://user:pass@localhost:5433/db',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.databaseReplicaUrl, 'postgres://user:pass@localhost:5433/db');
});

test('resolveConfig: handles DATABASE_URL_REPLICA as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.databaseReplicaUrl, null);
});

test('resolveConfig: handles SETTLEMENT_REPLICA_LAG_MS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    SETTLEMENT_REPLICA_LAG_MS: '2000',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.settlementReplicaLagMs, 2000);
});

test('resolveConfig: handles SETTLEMENT_REPLICA_LAG_MS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.settlementReplicaLagMs, 1000);
});

test('resolveConfig: handles OUTBOX_POLL_INTERVAL_MS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    OUTBOX_POLL_INTERVAL_MS: '2000',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.outboxPollIntervalMs, 2000);
});

test('resolveConfig: handles OUTBOX_POLL_INTERVAL_MS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.outboxPollIntervalMs, 5000);
});

test('resolveConfig: handles VAULT configuration with all required fields', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    VAULT_ADDR: 'https://vault.example.com:8200',
    VAULT_APPROLE_ROLE_ID: 'role-id-123',
    VAULT_APPROLE_SECRET_ID: 'secret-id-456',
    DATABASE_URL: 'postgres://host:5432/database', // no userinfo
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.vault.address, 'https://vault.example.com:8200');
  assert.strictEqual(config.vault.roleId, 'role-id-123');
  assert.strictEqual(config.vault.secretId, 'secret-id-456');
  assert.strictEqual(config.vault.dbMount, 'database');
  assert.strictEqual(config.vault.dbRole, 'facilitator');
  assert.strictEqual(config.vault.pollIntervalMs, 10000);
});

test('resolveConfig: throws when VAULT_ADDR is set but VAULT_APPROLE_ROLE_ID is missing', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    VAULT_ADDR: 'https://vault.example.com:8200',
    VAULT_APPROLE_SECRET_ID: 'secret-id-456',
    DATABASE_URL: 'postgres://host:5432/database',
  };
  assert.throws(
    () => resolveConfig(env),
    /VAULT_APPROLE_ROLE_ID and VAULT_APPROLE_SECRET_ID are not/,
  );
});

test('resolveConfig: throws when VAULT_ADDR is set but VAULT_APPROLE_SECRET_ID is missing', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    VAULT_ADDR: 'https://vault.example.com:8200',
    VAULT_APPROLE_ROLE_ID: 'role-id-123',
    DATABASE_URL: 'postgres://host:5432/database',
  };
  assert.throws(
    () => resolveConfig(env),
    /VAULT_APPROLE_ROLE_ID and VAULT_APPROLE_SECRET_ID are not/,
  );
});

test('resolveConfig: throws when VAULT_ADDR is set but DATABASE_URL is missing', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    VAULT_ADDR: 'https://vault.example.com:8200',
    VAULT_APPROLE_ROLE_ID: 'role-id-123',
    VAULT_APPROLE_SECRET_ID: 'secret-id-456',
  };
  assert.throws(() => resolveConfig(env), /VAULT_ADDR is set but DATABASE_URL is not/);
});

test('resolveConfig: throws when VAULT_ADDR is set but DATABASE_URL contains userinfo', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    VAULT_ADDR: 'https://vault.example.com:8200',
    VAULT_APPROLE_ROLE_ID: 'role-id-123',
    VAULT_APPROLE_SECRET_ID: 'secret-id-456',
    DATABASE_URL: 'postgres://user:pass@host:5432/database', // has userinfo
  };
  assert.throws(
    () => resolveConfig(env),
    /DATABASE_URL must not embed credentials when VAULT_ADDR is set/,
  );
});

test('resolveConfig: handles VAULT with custom namespace, db mount, and role', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    VAULT_ADDR: 'https://vault.example.com:8200',
    VAULT_NAMESPACE: 'team/stellar',
    VAULT_DB_MOUNT: 'postgres',
    VAULT_DB_ROLE: 'stellar-writer',
    VAULT_APPROLE_ROLE_ID: 'role-id-123',
    VAULT_APPROLE_SECRET_ID: 'secret-id-456',
    DATABASE_URL: 'postgres://host:5432/database',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.vault.namespace, 'team/stellar');
  assert.strictEqual(config.vault.dbMount, 'postgres');
  assert.strictEqual(config.vault.dbRole, 'stellar-writer');
});

test('resolveConfig: handles REGION', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    REGION: 'us-east-1',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.region, 'us-east-1');
});

test('resolveConfig: handles REGION as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.region, null);
});

test('resolveConfig: handles REGIONS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    REGIONS: 'us-east-1:1:http://us-east-1.example.com, eu-west-1:2:http://eu-west-1.example.com',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.regions, [
    { region: 'us-east-1', priority: 1, url: 'http://us-east-1.example.com' },
    { region: 'eu-west-1', priority: 2, url: 'http://eu-west-1.example.com' },
  ]);
});

test('resolveConfig: handles REGIONS as empty array when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.deepStrictEqual(config.regions, []);
});

test('resolveConfig: handles KAFKA_BROKERS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    KAFKA_BROKERS: 'kafka1:9092, kafka2:9092, kafka3:9092',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.kafka.brokers, ['kafka1:9092', 'kafka2:9092', 'kafka3:9092']);
});

test('resolveConfig: handles KAFKA_BROKERS as empty array when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.deepStrictEqual(config.kafka.brokers, []);
});

test('resolveConfig: handles KAFKA_CLIENT_ID custom value', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    KAFKA_CLIENT_ID: 'my-custom-client',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.kafka.clientId, 'my-custom-client');
});

test('resolveConfig: handles KAFKA_CLIENT_ID default value', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.kafka.clientId, 'x402-facilitator-stellar');
});

test('resolveConfig: handles KAFKA_WEBHOOK_TOPIC custom value', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    KAFKA_WEBHOOK_TOPIC: 'custom-webhook-topic',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.kafka.topic, 'custom-webhook-topic');
});

test('resolveConfig: handles KAFKA_WEBHOOK_TOPIC default value', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.kafka.topic, 'x402-webhook-delivery');
});

test('resolveConfig: handles KAFKA_WEBHOOK_GROUP_ID custom value', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    KAFKA_WEBHOOK_GROUP_ID: 'my-custom-group',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.kafka.groupId, 'my-custom-group');
});

test('resolveConfig: handles KAFKA_WEBHOOK_GROUP_ID default value', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.kafka.groupId, 'x402-webhook-dispatchers');
});

test('resolveConfig: handles KAFKA_WEBHOOK_DLQ_TOPIC', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    KAFKA_WEBHOOK_DLQ_TOPIC: 'dlq-topic',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.kafka.dlqTopic, 'dlq-topic');
});

test('resolveConfig: handles KAFKA_WEBHOOK_DLQ_TOPIC as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.kafka.dlqTopic, null);
});

test('resolveConfig: handles WEBHOOK_URL', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    WEBHOOK_URL: 'https://example.com/webhook',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.webhookUrl, 'https://example.com/webhook');
});

test('resolveConfig: handles WEBHOOK_URL as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.webhookUrl, null);
});

test('resolveConfig: handles DLQ configuration', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    DATABASE_URL: 'postgres://localhost:5432/db',
    DLQ_POLL_INTERVAL_MS: '5000',
    DLQ_MAX_RETRY_ATTEMPTS: '3',
    DLQ_BASE_BACKOFF_MS: '15000',
    DLQ_ALERT_THRESHOLD: '25',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.dlq.pollIntervalMs, 5000);
  assert.strictEqual(config.dlq.maxRetryAttempts, 3);
  assert.strictEqual(config.dlq.baseBackoffMs, 15000);
  assert.strictEqual(config.dlq.alertThreshold, 25);
});

test('resolveConfig: handles DLQ configuration with defaults', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    DATABASE_URL: 'postgres://localhost:5432/db',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.dlq.pollIntervalMs, 10000);
  assert.strictEqual(config.dlq.maxRetryAttempts, 5);
  assert.strictEqual(config.dlq.baseBackoffMs, 30000);
  assert.strictEqual(config.dlq.alertThreshold, 50);
});

test('resolveConfig: handles EMBEDDINGS_URL', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    EMBEDDINGS_URL: 'https://embeddings.example.com',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.embeddingsUrl, 'https://embeddings.example.com');
});

test('resolveConfig: handles EMBEDDINGS_URL as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.embeddingsUrl, null);
});

test('resolveConfig: handles EMBEDDINGS_TIMEOUT_MS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    EMBEDDINGS_TIMEOUT_MS: '5000',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.embeddingsTimeoutMs, 5000);
});

test('resolveConfig: handles EMBEDDINGS_TIMEOUT_MS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.embeddingsTimeoutMs, 3000);
});

test('resolveConfig: handles CATALOG_MAX_RESOURCES_PER_PAYTO', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    CATALOG_MAX_RESOURCES_PER_PAYTO: '25',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.catalogMaxResourcesPerPayTo, 25);
});

test('resolveConfig: handles CATALOG_MAX_RESOURCES_PER_PAYTO default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.catalogMaxResourcesPerPayTo, 50);
});

test('resolveConfig: handles CATALOG_VERIFY_TTL_MS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    CATALOG_VERIFY_TTL_MS: '7200000', // 2 hours
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.catalogVerifyTtlMs, 7200000);
});

test('resolveConfig: handles CATALOG_VERIFY_TTL_MS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  // 24 * 60 * 60 * 1000 = 86400000 (24 hours)
  assert.strictEqual(config.catalogVerifyTtlMs, 86400000);
});

test('resolveConfig: handles ENABLE_RERANKING', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_RERANKING: 'true',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.enableReranking, true);
});

test('resolveConfig: handles ENABLE_RERANKING falsy value', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_RERANKING: 'false',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.enableReranking, false);
});

test('resolveConfig: handles ENABLE_RERANKING default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.enableReranking, false);
});

test('resolveConfig: handles DISCOVERY_CACHE_MAX_AGE_SECONDS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    DISCOVERY_CACHE_MAX_AGE_SECONDS: '120',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.discoveryCache.maxAgeSeconds, 120);
});

test('resolveConfig: handles DISCOVERY_CACHE_MAX_AGE_SECONDS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.discoveryCache.maxAgeSeconds, 60);
});

test('resolveConfig: handles DISCOVERY_CACHE_STALE_SECONDS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    DISCOVERY_CACHE_STALE_SECONDS: '600',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.discoveryCache.staleWhileRevalidateSeconds, 600);
});

test('resolveConfig: handles DISCOVERY_CACHE_STALE_SECONDS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.discoveryCache.staleWhileRevalidateSeconds, 300);
});

test('resolveConfig: handles SHUTDOWN_GRACE_MS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    SHUTDOWN_GRACE_MS: '20000',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.shutdownGraceMs, 20000);
});

test('resolveConfig: handles SHUTDOWN_GRACE_MS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.shutdownGraceMs, 15000);
});

test('resolveConfig: handles REQUEST_TIMEOUT_MS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    REQUEST_TIMEOUT_MS: '45000',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.requestTimeoutMs, 45000);
});

test('resolveConfig: handles REQUEST_TIMEOUT_MS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.requestTimeoutMs, 30000);
});

test('resolveConfig: handles SETTLE_REQUIRE_DURABLE_STORE', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    SETTLE_REQUIRE_DURABLE_STORE: 'true',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.requireDurableSettlementStore, true);
});

test('resolveConfig: handles SETTLE_REQUIRE_DURABLE_STORE falsy value', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    SETTLE_REQUIRE_DURABLE_STORE: 'false',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.requireDurableSettlementStore, false);
});

test('resolveConfig: handles SETTLE_REQUIRE_DURABLE_STORE default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.requireDurableSettlementStore, false);
});

// Edge case tests

test('resolveConfig: handles empty string for FACILITATOR_API_KEYS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    FACILITATOR_API_KEYS: '',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.apiKeys, []); // Should be empty array
});

test('resolveConfig: handles whitespace-only FACILITATOR_API_KEYS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    FACILITATOR_API_KEYS: '   ,  ,  ',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.apiKeys, []); // Should be empty array after filtering
});

test('resolveConfig: handles CORS_ALLOWED_ORIGINS with only spaces and commas', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    CORS_ALLOWED_ORIGINS: '   ,  ,  ',
  };
  const config = resolveConfig(env);
  assert.deepStrictEqual(config.cors.allowedOrigins, []); // Should be empty array
});

test('resolveConfig: handles RATE_LIMIT_GLOBAL with empty string', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    RATE_LIMIT_GLOBAL: '',
  };
  const config = resolveConfig(env);
  // Should use default values
  assert.strictEqual(config.rateLimits.global.verifyRpm, 60);
  assert.strictEqual(config.rateLimits.global.settleRpm, 10);
  assert.strictEqual(config.rateLimits.global.settleRph, 100);
  assert.strictEqual(config.rateLimits.global.settleRpd, 1000);
  assert.strictEqual(config.rateLimits.global.feeSpd, 5000000);
  assert.strictEqual(config.rateLimits.global.catalogRpm, 10);
});

test('resolveConfig: handles RATE_LIMIT_GLOBAL with malformed pairs', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    RATE_LIMIT_GLOBAL: 'verify_rpm=invalid,settle_rpm=,=100,catalog_rpm',
  };
  const config = resolveConfig(env);
  // Invalid values should be ignored, keeping defaults
  assert.strictEqual(config.rateLimits.global.verifyRpm, 60); // default
  assert.strictEqual(config.rateLimits.global.settleRpm, 10); // default
  assert.strictEqual(config.rateLimits.global.settleRph, 100); // default
  assert.strictEqual(config.rateLimits.global.settleRpd, 1000); // default
  assert.strictEqual(config.rateLimits.global.feeSpd, 5000000); // default
  assert.strictEqual(config.rateLimits.global.catalogRpm, 10); // default
});

test('resolveConfig: handles METRICS_PORT', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    METRICS_PORT: '9090',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.metricsPort, 9090);
});

test('resolveConfig: handles METRICS_PORT as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.metricsPort, null);
});

test('resolveConfig: handles KEY_MANAGER_URL', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    KEY_MANAGER_URL: 'http://keymanager:8080',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[TESTNET].keyManagerUrl, 'http://keymanager:8080');
});

test('resolveConfig: handles KEY_MANAGER_URL as null when unset', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.perNetwork[TESTNET].keyManagerUrl, null);
});

test('resolveConfig: handles KEY_MANAGER_POLL_INTERVAL_MS', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    KEY_MANAGER_POLL_INTERVAL_MS: '3000',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[TESTNET].keyManagerPollIntervalMs, 3000);
});

test('resolveConfig: handles KEY_MANAGER_POLL_INTERVAL_MS default', () => {
  const config = resolveConfig({ FACILITATOR_SECRET: 'S123' });
  assert.strictEqual(config.perNetwork[TESTNET].keyManagerPollIntervalMs, 0);
});

test('resolveConfig: handles PUBNET key manager URL and poll interval', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
    KEY_MANAGER_URL_PUBNET: 'http://keymanager-pubnet:8080',
    KEY_MANAGER_POLL_INTERVAL_MS_PUBNET: '4000',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerUrl, 'http://keymanager-pubnet:8080');
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerPollIntervalMs, 4000);
});

test('resolveConfig: handles PUBNET key manager falling back to regular key manager', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
    KEY_MANAGER_URL: 'http://keymanager:8080',
    KEY_MANAGER_POLL_INTERVAL_MS: '3000',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerUrl, 'http://keymanager:8080');
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerPollIntervalMs, 3000);
});

test('resolveConfig: handles PUBNET key manager defaulting to 0 when both unset', () => {
  const env = {
    FACILITATOR_SECRET: 'S123',
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: 'S456',
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
  };
  const config = resolveConfig(env);
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerUrl, null);
  assert.strictEqual(config.perNetwork[PUBNET].keyManagerPollIntervalMs, 0);
});
