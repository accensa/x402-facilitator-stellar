/**
 * The `.sql` blind spot in scripts/check-migration-compat.js (#751).
 *
 * The scan filtered the entry list to `.js`, so a raw `.sql` migration was
 * never read: `DROP COLUMN`/`DROP TABLE` in one passed `npm run check:migration`
 * even though the same statement in a `.js` up() was blocked.
 *
 * These tests feed fixture migrations through the exported `checkMigrations()`
 * (and through the CLI for the exit codes) without touching migrations/. They
 * pin that `.sql` files are scanned, that the blocking rules are matched
 * case-insensitively across whitespace and quoted identifiers, that
 * commented-out statements are ignored, that a safe migration passes, and that
 * a `.sql` filename is held to the same timestamp convention as a `.js` one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../scripts/check-migration-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'check-migration-compat.js');
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const SAFE_SQL = `-- expand: new table plus a nullable column, no destruction
CREATE TABLE IF NOT EXISTS widgets (
    id BIGSERIAL PRIMARY KEY,
    name TEXT
);

ALTER TABLE widgets ADD COLUMN IF NOT EXISTS label TEXT;

CREATE INDEX IF NOT EXISTS idx_widgets_name ON widgets(name);
`;

/** Write fixture migrations into a throwaway directory and scan them. */
async function scan(files) {
  const dir = await mkdtemp(join(tmpdir(), 'migration-compat-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return await checkMigrations(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const errorsIn = issues => issues.filter(i => i.severity === 'error');
const warningsIn = issues => issues.filter(i => i.severity === 'warning');

test('a DROP COLUMN in a .sql migration is rejected', async () => {
  const { issues, files } = await scan({
    '20260101000000_drop_access_tier.sql':
      'ALTER TABLE discovery_resources DROP COLUMN access_tier;\n',
  });

  assert.deepEqual(files, ['20260101000000_drop_access_tier.sql']);
  const errors = errorsIn(issues);
  assert.equal(errors.length, 1, 'expected exactly one blocking issue');
  assert.match(errors[0].message, /DROP COLUMN/);
  assert.equal(errors[0].file, '20260101000000_drop_access_tier.sql');
  assert.equal(errors[0].line, 1);
});

test('a DROP TABLE in a .sql migration is rejected', async () => {
  const { issues } = await scan({
    '20260101000000_drop_settlements.sql': 'DROP TABLE IF EXISTS settlements;\n',
  });

  const errors = errorsIn(issues);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /DROP TABLE/);
});

test('lowercase, multiline and quoted variants are still rejected', async () => {
  const { issues } = await scan({
    '20260101000000_destructive.sql': `drop table if exists "settlements";

alter table "discovery_resources"
    drop column
        "access_tier";

alter table "discovery_resources" alter column "url" set data type varchar(2048);
alter table "discovery_resources" rename column "url" to "resource_url";
lock table "discovery_resources" in access exclusive mode;
`,
  });

  const errors = errorsIn(issues);
  assert.equal(errors.length, 5, `expected five blocking issues, got ${JSON.stringify(errors)}`);
  assert.deepEqual(
    errors.map(e => e.message.split(' ').slice(0, 2).join(' ')),
    ['DROP TABLE', 'DROP COLUMN', 'ALTER COLUMN', 'RENAME breaks', 'Explicit LOCK'],
  );
  // Line numbers point at the original file, not at the stripped copy.
  assert.deepEqual(
    errors.map(e => e.line),
    [1, 4, 7, 8, 9],
  );
});

test('a commented-out DROP is not rejected', async () => {
  const { issues } = await scan({
    '20260101000000_commented.sql': `-- legacy cleanup: ALTER TABLE widgets DROP COLUMN label;
/* DROP TABLE widgets;
   ALTER TABLE widgets ALTER COLUMN label TYPE text; */
CREATE TABLE IF NOT EXISTS widgets (id BIGSERIAL PRIMARY KEY);
-- SELECT 'DROP TABLE widgets' AS still_a_string;
`,
  });

  assert.deepEqual(errorsIn(issues), []);
});

test('a safe .sql migration passes', async () => {
  const { issues } = await scan({ '20260101000000_widgets.sql': SAFE_SQL });

  assert.deepEqual(errorsIn(issues), []);
  assert.deepEqual(warningsIn(issues), []);
});

test('a bad .sql filename is flagged like a bad .js one', async () => {
  const js = `export const up = pgm => {
  pgm.createTable('widgets', { id: 'id' });
};

export const down = pgm => {
  pgm.dropTable('widgets');
};
`;
  const { issues } = await scan({
    'widgets.sql': SAFE_SQL,
    'widgets.js': js,
  });

  assert.deepEqual(errorsIn(issues), []);
  const filenameWarnings = warningsIn(issues).filter(i =>
    i.message.includes('numeric timestamp prefix'),
  );
  assert.deepEqual(filenameWarnings.map(i => i.file).sort(), ['widgets.js', 'widgets.sql']);
});

test('the CLI exits 1 on a destructive .sql migration and 0 on a safe one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-compat-cli-'));
  try {
    await writeFile(
      join(dir, '20260101000000_bad.sql'),
      'ALTER TABLE widgets DROP COLUMN label;\n',
    );
    const bad = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /ERROR\s+20260101000000_bad\.sql:1 — DROP COLUMN/);
    assert.match(bad.stderr, /1 error\(s\), 0 warning\(s\)/);

    await rm(join(dir, '20260101000000_bad.sql'));
    await writeFile(join(dir, '20260101000000_safe.sql'), SAFE_SQL);
    const good = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    assert.equal(good.status, 0);
    assert.match(good.stdout, /Migration compatibility check passed \(1 files scanned\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the repository migrations/ still passes and now includes its .sql files', async () => {
  const { issues, files } = await checkMigrations(MIGRATIONS_DIR);

  assert.deepEqual(errorsIn(issues), []);
  assert.ok(
    files.filter(f => f.endsWith('.sql')).length > 0,
    'the .sql migrations must be part of the scan',
  );
  assert.ok(
    files.includes('001_bazaar_catalog.sql') && files.includes('004_outbox_events.sql'),
    'the legacy .sql files must be listed',
  );
});
