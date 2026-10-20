#!/usr/bin/env node

/**
 * Data retention job — enforces the policy in docs/PRIVACY.md:
 *   request logs        7 days
 *   search queries     30 days (not yet implemented, see issue #25)
 *   settlement records 90 days
 *
 * Usage:
 *   node scripts/data_retention_job.js --apply     # actually purge
 *   node scripts/data_retention_job.js --dry-run   # simulate, default
 *   node scripts/data_retention_job.js --help      # show help
 *
 * The job operates in small batches with sleep pauses to avoid database
 * locking. It can archive purged records to local JSONL or S3 before
 * deletion, and emits a detailed operational report.
 */

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const RETENTION_DAYS = {
  'request logs': 7,
  'search queries': 30,
  'settlement records': 90,
};

const BATCH_SIZE = 500;
const BATCH_SLEEP_MS = 100;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class Archiver {
  constructor({ type = 'local', path = './retention-archive', s3 } = {}) {
    this.type = type;
    this.path = path;
    this.s3 = s3;
    this.fileHandle = null;
    this.currentFile = null;
    this.recordCount = 0;
  }

  async open() {
    if (this.type === 's3') {
      if (!this.s3?.client || !this.s3?.bucket) {
        throw new Error('S3 archival requires s3.client and s3.bucket');
      }
      this.currentFile = `s3://${this.s3.bucket}/retention/${new Date().toISOString().slice(0, 10)}/${Date.now()}.jsonl`;
    } else {
      const { mkdirSync, createWriteStream } = await import('node:fs');
      const { dirname: _dirname } = await import('node:path');
      mkdirSync(this.path, { recursive: true });
      this.currentFile = `${this.path}/retention-${new Date().toISOString().slice(0, 10)}-${Date.now()}.jsonl`;
      this.fileHandle = createWriteStream(this.currentFile, { flags: 'a' });
    }
  }

  async write(record) {
    const line = JSON.stringify(record) + '\n';
    if (this.type === 's3') {
      this.recordBuffer = (this.recordBuffer || '') + line;
      this.recordCount++;
    } else {
      this.fileHandle.write(line);
      this.recordCount++;
    }
  }

  async close() {
    if (this.type === 's3' && this.recordBuffer) {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await this.s3.client.send(
        new PutObjectCommand({
          Bucket: this.s3.bucket,
          Key: this.currentFile.replace(`s3://${this.s3.bucket}/`, ''),
          Body: this.recordBuffer,
          ContentType: 'application/jsonlines',
        }),
      );
    } else if (this.fileHandle) {
      await new Promise((resolve, reject) => {
        this.fileHandle.end(err => (err ? reject(err) : resolve()));
      });
    }
  }
}

function buildPgPool(databaseUrl) {
  const { Pool } = require('pg');
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
}

async function runBatchDelete(
  pool,
  table,
  whereClause,
  params,
  batchSize,
  sleepMs,
  archiver,
  dryRun,
) {
  let totalDeleted = 0;
  let totalArchived = 0;

  while (true) {
    const selectSql = `SELECT * FROM ${table} WHERE ${whereClause} LIMIT $${params.length + 1}`;
    const selectParams = [...params, batchSize];

    const { rows } = await pool.query(selectSql, selectParams);
    if (rows.length === 0) break;

    if (archiver) {
      for (const row of rows) {
        await archiver.write({ table, ...row });
      }
      totalArchived += rows.length;
    }

    if (!dryRun) {
      const deleteSql = `DELETE FROM ${table} WHERE ${whereClause} AND ctid IN (
        SELECT ctid FROM ${table} WHERE ${whereClause} LIMIT $${params.length + 1}
      )`;
      const { rowCount } = await pool.query(deleteSql, selectParams);
      totalDeleted += rowCount ?? 0;
    } else {
      totalDeleted += rows.length;
    }

    if (rows.length < batchSize) break;
    await sleep(sleepMs);
  }

  return { deleted: totalDeleted, archived: totalArchived };
}

async function purgeSettlementEvents(pool, cutoff, batchSize, sleepMs, archiver, dryRun) {
  return runBatchDelete(
    pool,
    'settlement_events',
    'recorded_at < $1',
    [cutoff],
    batchSize,
    sleepMs,
    archiver,
    dryRun,
  );
}

async function purgeSettlementProjections(pool, cutoff, batchSize, sleepMs, archiver, dryRun) {
  return runBatchDelete(
    pool,
    'settlement_projections',
    'updated_at < $1',
    [cutoff],
    batchSize,
    sleepMs,
    archiver,
    dryRun,
  );
}

async function purgeLegacySettlements(pool, cutoff, batchSize, sleepMs, archiver, dryRun) {
  return runBatchDelete(
    pool,
    'settlements',
    'updated_at < $1',
    [cutoff],
    batchSize,
    sleepMs,
    archiver,
    dryRun,
  );
}

async function purgeIdempotencyKeys(pool, cutoff, batchSize, sleepMs, archiver, dryRun) {
  return runBatchDelete(
    pool,
    'idempotency_keys',
    'created_at < $1',
    [cutoff],
    batchSize,
    sleepMs,
    archiver,
    dryRun,
  );
}

async function purgeOutboxEvents(pool, cutoff, batchSize, sleepMs, archiver, dryRun) {
  return runBatchDelete(
    pool,
    'outbox_events',
    "created_at < $1 AND status = 'published'",
    [cutoff],
    batchSize,
    sleepMs,
    archiver,
    dryRun,
  );
}

async function purgeDeadLetters(pool, cutoff, batchSize, sleepMs, archiver, dryRun) {
  return runBatchDelete(
    pool,
    'dead_letters',
    "first_failed_at < $1 AND status IN ('resolved', 'discarded')",
    [cutoff],
    batchSize,
    sleepMs,
    archiver,
    dryRun,
  );
}

async function purgeRateLimitBuckets(pool, cutoff, batchSize, sleepMs, archiver, dryRun) {
  return runBatchDelete(
    pool,
    'rate_limit_buckets',
    'reset_at < $1',
    [cutoff],
    batchSize,
    sleepMs,
    archiver,
    dryRun,
  );
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      apply: { type: 'boolean', short: 'a', default: false },
      'dry-run': { type: 'boolean', short: 'd', default: true },
      'batch-size': { type: 'string', default: String(BATCH_SIZE) },
      'batch-sleep-ms': { type: 'string', default: String(BATCH_SLEEP_MS) },
      'archive-type': { type: 'string', default: 'local' },
      'archive-path': { type: 'string', default: './retention-archive' },
      's3-bucket': { type: 'string' },
      's3-region': { type: 'string', default: 'us-east-1' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
Data Retention Job — enforces docs/PRIVACY.md retention policy

Usage:
  node scripts/data_retention_job.js [options]

Options:
  -a, --apply                    Actually purge records (default: dry-run)
  -d, --dry-run                  Simulate only, no changes (default)
      --batch-size <n>           Batch size for deletes (default: ${BATCH_SIZE})
      --batch-sleep-ms <ms>      Sleep between batches (default: ${BATCH_SLEEP_MS})
      --archive-type <type>      'local' or 's3' (default: local)
      --archive-path <path>      Local archive directory (default: ./retention-archive)
      --s3-bucket <bucket>       S3 bucket for archival (required if --archive-type=s3)
      --s3-region <region>       S3 region (default: us-east-1)
  -h, --help                     Show this help

Retention periods (from docs/PRIVACY.md):
  Request logs:        ${RETENTION_DAYS['request logs']} days
  Search queries:      ${RETENTION_DAYS['search queries']} days (not yet implemented)
  Settlement records:  ${RETENTION_DAYS['settlement records']} days
`);
    process.exit(0);
  }

  const dryRun = !values.apply;
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is required');
    console.error('This job purges records from the Postgres database.');
    process.exit(1);
  }

  if (values['archive-type'] === 's3' && !values['s3-bucket']) {
    console.error('ERROR: --s3-bucket is required when --archive-type=s3');
    process.exit(1);
  }

  const batchSize = parseInt(values['batch-size'], 10);
  const batchSleepMs = parseInt(values['batch-sleep-ms'], 10);

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    console.error('ERROR: --batch-size must be a positive integer');
    process.exit(1);
  }
  if (!Number.isInteger(batchSleepMs) || batchSleepMs < 0) {
    console.error('ERROR: --batch-sleep-ms must be a non-negative integer');
    process.exit(1);
  }

  const pool = buildPgPool(databaseUrl);

  const now = new Date();
  const settlementCutoff = new Date(
    now.getTime() - RETENTION_DAYS['settlement records'] * 24 * 60 * 60 * 1000,
  );
  const requestCutoff = new Date(
    now.getTime() - RETENTION_DAYS['request logs'] * 24 * 60 * 60 * 1000,
  );
  const searchCutoff = new Date(
    now.getTime() - RETENTION_DAYS['search queries'] * 24 * 60 * 60 * 1000,
  );

  console.log(`=== Data Retention Job ${dryRun ? '(DRY RUN)' : '(APPLY)'} ===`);
  console.log(`Started at: ${now.toISOString()}`);
  console.log(`Database: ${new URL(databaseUrl).hostname}`);
  console.log(`Retention cutoffs:`);
  console.log(`  Settlement records (90d): ${settlementCutoff.toISOString()}`);
  console.log(`  Request logs (7d):        ${requestCutoff.toISOString()}`);
  console.log(`  Search queries (30d):     ${searchCutoff.toISOString()} (not yet implemented)`);
  console.log(`Batch size: ${batchSize}, Sleep: ${batchSleepMs}ms`);
  console.log(
    `Archive: ${values['archive-type']}${values['archive-type'] === 's3' ? ` (s3://${values['s3-bucket']})` : ` (${values['archive-path']})`}`,
  );
  console.log('');

  const archiver = new Archiver({
    type: values['archive-type'],
    path: values['archive-path'],
    s3:
      values['archive-type'] === 's3'
        ? {
            bucket: values['s3-bucket'],
            client: (async () => {
              const { S3Client } = await import('@aws-sdk/client-s3');
              return new S3Client({ region: values['s3-region'] });
            })(),
          }
        : undefined,
  });

  let archiverOpened = false;

  const ensureArchiver = async () => {
    if (!archiverOpened) {
      await archiver.open();
      archiverOpened = true;
    }
  };

  const report = {
    startedAt: now.toISOString(),
    dryRun,
    retention: { ...RETENTION_DAYS },
    tables: {},
    totals: { deleted: 0, archived: 0 },
    errors: [],
  };

  try {
    const tasks = [
      {
        name: 'settlement_events',
        fn: () =>
          purgeSettlementEvents(pool, settlementCutoff, batchSize, batchSleepMs, archiver, dryRun),
        cutoff: settlementCutoff,
      },
      {
        name: 'settlement_projections',
        fn: () =>
          purgeSettlementProjections(
            pool,
            settlementCutoff,
            batchSize,
            batchSleepMs,
            archiver,
            dryRun,
          ),
        cutoff: settlementCutoff,
      },
      {
        name: 'settlements (legacy)',
        fn: () =>
          purgeLegacySettlements(pool, settlementCutoff, batchSize, batchSleepMs, archiver, dryRun),
        cutoff: settlementCutoff,
      },
      {
        name: 'idempotency_keys',
        fn: () =>
          purgeIdempotencyKeys(pool, requestCutoff, batchSize, batchSleepMs, archiver, dryRun),
        cutoff: requestCutoff,
      },
      {
        name: 'outbox_events (published)',
        fn: () =>
          purgeOutboxEvents(pool, settlementCutoff, batchSize, batchSleepMs, archiver, dryRun),
        cutoff: settlementCutoff,
      },
      {
        name: 'dead_letters (resolved/discarded)',
        fn: () =>
          purgeDeadLetters(pool, settlementCutoff, batchSize, batchSleepMs, archiver, dryRun),
        cutoff: settlementCutoff,
      },
      {
        name: 'rate_limit_buckets (expired)',
        fn: () =>
          purgeRateLimitBuckets(pool, requestCutoff, batchSize, batchSleepMs, archiver, dryRun),
        cutoff: requestCutoff,
      },
    ];

    for (const task of tasks) {
      console.log(`Processing ${task.name} (older than ${task.cutoff.toISOString()})...`);
      try {
        await ensureArchiver();
        const result = await task.fn();
        report.tables[task.name] = {
          cutoff: task.cutoff.toISOString(),
          deleted: result.deleted,
          archived: result.archived,
        };
        report.totals.deleted += result.deleted;
        report.totals.archived += result.archived;
        console.log(`  Deleted: ${result.deleted}, Archived: ${result.archived}`);
      } catch (err) {
        const errorMsg = `${task.name}: ${err.message}`;
        report.errors.push(errorMsg);
        console.error(`  ERROR: ${errorMsg}`);
      }
    }

    await archiver.close();

    report.completedAt = new Date().toISOString();
    report.durationMs = Date.now() - now.getTime();

    console.log('');
    console.log('=== Retention Job Complete ===');
    console.log(`Duration: ${report.durationMs}ms`);
    console.log(`Total deleted: ${report.totals.deleted}`);
    console.log(`Total archived: ${report.totals.archived}`);
    if (report.errors.length > 0) {
      console.log(`Errors: ${report.errors.length}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('FATAL:', err.message);
    report.errors.push(`FATAL: ${err.message}`);
    report.completedAt = new Date().toISOString();
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
