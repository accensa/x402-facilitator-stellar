/**
 * The migration guardrail's own rules (#743).
 *
 * test/migrations.test.js re-implements two regexes against the repository's
 * current migration files, so it never exercises scripts/check-migration-compat.js.
 * A broken pattern there would silently pass every migration through CI: the
 * check would print "passed" while the dangerous DDL it exists to block got
 * merged.
 *
 * These tests drive the exported `checkMigrations()` — and the CLI's exit code —
 * against temporary fixture directories, one rule at a time, with a violating
 * migration and a safe one. Nothing here writes to migrations/.
 *
 * The checker does not expose its rule names in `issues`; each case carries the
 * rule name from scripts/check-migration-compat.js and asserts the message that
 * rule emits, so a renamed or reworded rule is a visible failure rather than a
 * silent pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../scripts/check-migration-compat.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'check-migration-compat.js');

/**
 * A node-pg-migrate migration whose up() contains `sql` inside pgm.sql() and
 * whose down() is empty. Single quotes keep the checker's backtick-only
 * pgm.sql() scan from double-reporting the same statement.
 */
function jsMigration(sql) {
  return `export const up = pgm => {
  pgm.sql('${sql}');
};

export const down = pgm => {};
`;
}

/** Create a temp dir with `files`, run `fn(dir)`, then remove the dir. */
async function withFixture(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'x402-migration-rules-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run the checker CLI against `dir` and resolve with status and output. */
function runCli(dir) {
  return new Promise(resolve => {
    execFile(process.execPath, [SCRIPT, dir], (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });
}

/**
 * Blocking rules, each with a statement that must trip it. The rule name is
 * the `name` field in the checker's CHECKS table.
 */
const BLOCKING_RULES = [
  {
    rule: 'no-drop-table-in-up',
    sql: 'DROP TABLE legacy_events',
    message: 'DROP TABLE in an expand (up) migration breaks running code',
  },
  {
    rule: 'no-drop-column-in-up',
    sql: 'ALTER TABLE discovery_resources DROP COLUMN access_tier',
    message: 'DROP COLUMN in an expand (up) migration breaks running code',
  },
  {
    rule: 'no-rename-in-up (RENAME COLUMN)',
    sql: 'ALTER TABLE discovery_resources RENAME COLUMN status TO access_tier',
    message: 'RENAME breaks running code',
  },
  {
    rule: 'no-rename-in-up (RENAME TO)',
    sql: 'ALTER TABLE discovery_resources RENAME TO resources',
    message: 'RENAME breaks running code',
  },
  {
    rule: 'no-lock-table',
    sql: 'LOCK TABLE discovery_resources IN ACCESS EXCLUSIVE MODE',
    message: 'Explicit LOCK TABLE blocks reads',
  },
  {
    rule: 'no-alter-column-type',
    sql: 'ALTER TABLE settlements ALTER COLUMN amount TYPE bigint',
    message: 'ALTER COLUMN ... TYPE rewrites the table',
  },
];

const WARNING_RULES = [
  {
    rule: 'no-not-null-without-default',
    sql: 'ALTER TABLE discovery_resources ADD COLUMN access_tier varchar(50) NOT NULL',
    message: 'NOT NULL without DEFAULT on an existing table requires a backfill',
  },
  {
    rule: 'no-create-index-non-concurrent',
    sql: 'CREATE INDEX idx_resources_url ON discovery_resources (url)',
    message: 'CREATE INDEX without CONCURRENTLY acquires an ACCESS EXCLUSIVE lock',
  },
];

test('every blocking rule flags a violating JS up() migration', async () => {
  for (const { rule, sql, message } of BLOCKING_RULES) {
    await withFixture({ '20260101000000_violation.js': jsMigration(sql) }, async dir => {
      const { issues, files } = await checkMigrations(dir);

      assert.deepEqual(files, ['20260101000000_violation.js']);

      const errors = issues.filter(issue => issue.severity === 'error');
      assert.equal(
        errors.length,
        1,
        `${rule}: expected exactly one error, got ${JSON.stringify(issues)}`,
      );
      assert.match(errors[0].message, new RegExp(escapeRegExp(message)), `${rule}: wrong message`);
      assert.equal(errors[0].file, '20260101000000_violation.js');
      assert.ok(errors[0].line > 0, `${rule}: the error must point at the statement line`);
    });
  }
});

test('every advisory rule warns about a violating JS up() migration', async () => {
  for (const { rule, sql, message } of WARNING_RULES) {
    await withFixture({ '20260101000000_warning.js': jsMigration(sql) }, async dir => {
      const { issues } = await checkMigrations(dir);

      assert.equal(
        issues.length,
        1,
        `${rule}: expected exactly one issue, got ${JSON.stringify(issues)}`,
      );
      assert.equal(issues[0].severity, 'warning', `${rule}: must not block a deploy`);
      assert.match(issues[0].message, new RegExp(escapeRegExp(message)), `${rule}: wrong message`);
      assert.ok(issues[0].line > 0, `${rule}: the warning must point at the statement line`);
    });
  }
});

test('destructive DDL in down() is allowed — the rules apply to the expand phase', async () => {
  const content = `export const up = pgm => {
  pgm.addColumn('discovery_resources', 'access_tier', { type: 'varchar(50)' });
};

export const down = pgm => {
  pgm.dropColumn('discovery_resources', 'access_tier');
  pgm.dropTable('legacy_events');
};
`;
  await withFixture({ '20260101000000_contract.js': content }, async dir => {
    const { issues } = await checkMigrations(dir);
    assert.deepEqual(issues, [], 'rollback DDL must not be reported as an expand violation');
  });
});

test('a safe expand migration produces no blocking issues', async () => {
  const content = `export const up = pgm => {
  pgm.addColumn('discovery_resources', 'feature_flags', { type: 'JSONB' });
};

export const down = pgm => {
  pgm.dropColumn('discovery_resources', 'feature_flags');
};
`;
  await withFixture({ '20260101000000_expand_add_feature_flags.js': content }, async dir => {
    // The filename says "add_feature_flags" without a matching contract file,
    // so the expand/contract advisory fires — assert it is the only issue and
    // that no blocking rule did.
    const { issues } = await checkMigrations(dir);
    assert.deepEqual(
      issues.map(issue => issue.severity),
      ['warning'],
      `safe expand produced unexpected issues: ${JSON.stringify(issues)}`,
    );
    assert.match(issues[0].message, /no contract migration to remove it was found/);
  });
});

test('a raw .sql migration is treated as the expand phase and flags destructive DDL', async () => {
  const sql = `-- legacy schema, applied forward once
CREATE TABLE legacy_events (id bigint PRIMARY KEY);
ALTER TABLE discovery_resources DROP COLUMN status;
`;
  await withFixture({ '20260101000000_legacy.sql': sql }, async dir => {
    const { issues } = await checkMigrations(dir);
    const errors = issues.filter(issue => issue.severity === 'error');

    assert.equal(errors.length, 1, JSON.stringify(issues));
    assert.match(
      errors[0].message,
      /DROP COLUMN in an expand \(up\) migration breaks running code/,
    );
    assert.equal(errors[0].line, 3, 'the reported line must be the one the DROP is on');
  });
});

test('commented-out and string-literal DDL in a .sql migration is ignored', async () => {
  const sql = `-- DROP TABLE discovery_resources;
/* DROP COLUMN access_tier; */
CREATE TABLE legacy_events (id bigint PRIMARY KEY);
INSERT INTO legacy_events VALUES (1);
SELECT 'DROP TABLE discovery_resources';
`;
  await withFixture({ '20260101000000_safe_legacy.sql': sql }, async dir => {
    const { issues } = await checkMigrations(dir);
    assert.deepEqual(issues, [], 'comments and string literals must not be reported as DDL');
  });
});

test('the missing-contract advisory fires only when the contract is absent', async () => {
  const expand = `export const up = pgm => {
  pgm.addColumn('discovery_resources', 'widgets', { type: 'JSONB' });
};

export const down = pgm => {
  pgm.dropColumn('discovery_resources', 'widgets');
};
`;
  const contract = `export const up = pgm => {
  pgm.dropColumn('discovery_resources', 'widgets');
};

export const down = pgm => {
  pgm.addColumn('discovery_resources', 'widgets', { type: 'JSONB' });
};
`;

  await withFixture({ '20260101000000_add_widgets.js': expand }, async dir => {
    const { issues } = await checkMigrations(dir);
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.match(issues[0].message, /Expand migration adds "widgets" but no contract migration/);
  });

  await withFixture(
    {
      '20260101000000_add_widgets.js': expand,
      '20260102000000_drop_widgets.js': contract,
    },
    async dir => {
      const { issues } = await checkMigrations(dir);
      assert.deepEqual(issues, [], 'a matching drop_* contract must satisfy the advisory');
    },
  );
});

test('a filename without a numeric timestamp prefix is warned about', async () => {
  const content = `export const up = pgm => {
  pgm.addColumn('discovery_resources', 'feature_flags', { type: 'JSONB' });
};

export const down = pgm => {
  pgm.dropColumn('discovery_resources', 'feature_flags');
};
`;
  await withFixture({ 'feature_flags.js': content }, async dir => {
    const { issues } = await checkMigrations(dir);
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.match(issues[0].message, /numeric timestamp prefix/);
    assert.equal(issues[0].file, 'feature_flags.js');
  });
});

test('the CLI exits 1 and names the violation for a violating expand migration', async () => {
  await withFixture(
    { '20260101000000_violation.js': jsMigration('DROP TABLE legacy_events') },
    async dir => {
      const { status, stdout, stderr } = await runCli(dir);

      assert.equal(status, 1, 'a blocking violation must fail the command');
      assert.equal(stdout, '', 'the report belongs on stderr');
      assert.match(stderr, /Migration compatibility issues found/);
      assert.match(stderr, /ERROR\s+20260101000000_violation\.js:\d+ — DROP TABLE/);
      assert.match(stderr, /1 error\(s\), 0 warning\(s\)/);
      assert.match(stderr, /Blocking: fix the errors above before merging/);
    },
  );
});

test('the CLI exits 0 with a pass message for a safe migration', async () => {
  const content = `export const up = pgm => {
  pgm.addColumn('discovery_resources', 'feature_flags', { type: 'JSONB' });
};

export const down = pgm => {
  pgm.dropColumn('discovery_resources', 'feature_flags');
};
`;
  await withFixture({ '20260101000000_feature_flags.js': content }, async dir => {
    const { status, stdout, stderr } = await runCli(dir);

    assert.equal(status, 0);
    assert.match(stdout, /Migration compatibility check passed \(1 files scanned\)\./);
    assert.equal(stderr, '');
  });
});

test('the CLI exits 0 when the directory has no migrations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'x402-migration-empty-'));
  try {
    // A subdirectory proves only migration extensions are counted.
    await mkdir(join(dir, 'ignored'));
    const { status, stdout } = await runCli(dir);
    assert.equal(status, 0);
    assert.match(stdout, /No migration files found\. Nothing to check\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
