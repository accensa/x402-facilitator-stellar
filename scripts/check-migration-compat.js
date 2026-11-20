#!/usr/bin/env node

/**
 * Migration backward-compatibility checker.
 *
 * CI guardrail: scans the migrations directory for patterns that break
 * zero-downtime deployment. Run on every PR that touches migration files.
 *
 * Exit 0 = safe to deploy, exit 1 = blocking issues found.
 *
 * Checks enforced:
 *   1. No DROP TABLE / DROP COLUMN in expand (up) migrations — use the
 *      contract phase instead.
 *   2. No NOT NULL without a DEFAULT on existing tables — requires backfill.
 *   3. No renames without a two-phase expand+contract — use add+drop.
 *   4. New columns must be nullable or have a DEFAULT — old code must not
 *      break when the column does not exist in its expected shape.
 *   5. No ADD COLUMN ... NOT NULL without DEFAULT (PG < 11 full rewrite).
 *   6. No locking DDL that blocks reads (explicit LOCK TABLE).
 *   7. Contract migrations must exist for every expand that adds state.
 *   8. No ALTER COLUMN ... TYPE rewrites — add a column and backfill instead.
 *
 * Both `.js` (node-pg-migrate) and `.sql` (legacy psql) migrations are
 * scanned. A `.js` migration has an up()/down() split, so the blocking rules
 * apply to up() only. A raw `.sql` migration has no down phase — it is
 * applied forward once — so the whole file is treated as the expand (up)
 * phase: destructive DDL there is an error, and the removal belongs in a
 * `.js` contract migration (pgm.dropColumn/pgm.dropTable). SQL is matched
 * with comments and string literals blanked out first, so a commented-out
 * DROP does not fail the check. The advisory warnings (NOT NULL without
 * DEFAULT, CREATE INDEX without CONCURRENTLY) stay `.js`-only: the legacy
 * `.sql` files are already applied, so re-flagging their CREATE TABLE NOT
 * NULL columns would be noise rather than a guardrail.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_EXTENSIONS = ['.js', '.sql'];

/**
 * Pattern matchers for backward-incompatible SQL.
 */
const CHECKS = [
  {
    name: 'no-drop-table-in-up',
    pattern: /\bDROP\s+TABLE\b/gi,
    phase: 'up',
    severity: 'error',
    message:
      'DROP TABLE in an expand (up) migration breaks running code. Move to a contract (down) migration.',
  },
  {
    name: 'no-drop-column-in-up',
    pattern: /\bDROP\s+COLUMN\b/gi,
    phase: 'up',
    severity: 'error',
    message:
      'DROP COLUMN in an expand (up) migration breaks running code. Move to a contract (down) migration.',
  },
  {
    name: 'no-rename-in-up',
    // `RENAME TO` is the ALTER TABLE spelling of the same table rename.
    pattern: /\bRENAME\s+(?:TABLE|COLUMN|TO)\b/gi,
    phase: 'up',
    severity: 'error',
    message:
      'RENAME breaks running code. Use add-column + backfill + drop-column instead (expand-and-contract).',
  },
  {
    name: 'no-lock-table',
    pattern: /\bLOCK\s+TABLE\b/gi,
    phase: 'up',
    severity: 'error',
    message:
      'Explicit LOCK TABLE blocks reads. Use CONCURRENTLY for index operations and avoid table-level locks.',
  },
  {
    name: 'no-alter-column-type',
    pattern: /\bALTER\s+(?:COLUMN\s+)?[\w".]+\s+(?:SET\s+DATA\s+)?TYPE\b/gi,
    phase: 'up',
    severity: 'error',
    message:
      'ALTER COLUMN ... TYPE rewrites the table and breaks code still reading the old type. Add a new column, backfill, then drop the old one (expand-and-contract).',
  },
  {
    name: 'no-not-null-without-default',
    pattern: /\bNOT\s+NULL\b(?![\s\S]*?\bDEFAULT\b)/gi,
    phase: 'up',
    severity: 'warning',
    message:
      'NOT NULL without DEFAULT on an existing table requires a backfill or will reject existing rows.',
  },
  {
    name: 'no-create-index-non-concurrent',
    pattern: /\bCREATE\s+INDEX\b(?![\s\S]*?\bCONCURRENTLY\b)/gi,
    phase: 'up',
    severity: 'warning',
    message:
      'CREATE INDEX without CONCURRENTLY acquires an ACCESS EXCLUSIVE lock. Use CONCURRENTLY for large tables.',
  },
];

/**
 * Rules that block a deploy. Applied to `.js` up() bodies and to every raw
 * `.sql` migration, which has no down phase to move destructive DDL into.
 */
const BLOCKING_CHECKS = CHECKS.filter(check => check.phase === 'up' && check.severity === 'error');

/**
 * Blank out SQL comments and single-quoted string literals, preserving every
 * character offset (and newline) so reported line numbers still point at the
 * original text. Double-quoted identifiers are left alone: `DROP "COLUMN"` is
 * already caught by the keyword patterns, and `"DROP COLUMN"` as an
 * identifier name is not DDL.
 */
function stripSqlComments(sql) {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    // /* block comment */
    if (ch === '/' && sql[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < sql.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    // 'string literal' — a doubled quote is an escaped quote.
    if (ch === "'") {
      out += ' ';
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += '  ';
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out += ' ';
          i++;
          break;
        }
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // $tag$ dollar-quoted body $tag$
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? sql.length : close + tag[0].length;
        while (i < end) {
          out += sql[i] === '\n' ? '\n' : ' ';
          i++;
        }
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Check a raw `.sql` migration. It has no up()/down() split, so the whole
 * file is the expand (up) phase and every blocking rule applies to it.
 */
function checkSqlMigration(file, content, report) {
  const sql = stripSqlComments(content);
  const found = [];

  for (const check of BLOCKING_CHECKS) {
    const regex = new RegExp(check.pattern.source, check.pattern.flags);
    let m;
    while ((m = regex.exec(sql)) !== null) {
      const line = sql.substring(0, m.index).split('\n').length;
      found.push({ line, message: check.message });
    }
  }

  // Report in file order rather than grouped by rule.
  for (const issue of found.sort((a, b) => a.line - b.line)) {
    report.error(file, issue.line, issue.message);
  }
}

/**
 * Check a node-pg-migrate `.js` migration: the SQL builder calls plus raw
 * pgm.sql() bodies inside up().
 */
function checkJsMigration(file, content, report) {
  // Determine the migration phase from exports.
  const hasUp = content.includes('export const up');
  const hasDown = content.includes('export const down');

  if (!hasUp) {
    report.warn(file, 0, 'Migration file is missing an up() export.');
  }
  if (!hasDown) {
    report.warn(file, 0, 'Migration file is missing a down() export (rollback).');
  }

  // Check SQL strings inside the up() function.
  const upMatch = content.match(/export const up\s*=\s*pgm\s*=>\s*\{([\s\S]*?)\n\};/);
  if (upMatch) {
    const upBody = upMatch[1];
    // Strip line comments so we do not flag comment text as SQL issues.
    const upBodyCode = upBody.replace(/\/\/.*$/gm, '');
    for (const check of CHECKS) {
      if (check.phase !== 'up') continue;
      const regex = new RegExp(check.pattern.source, 'gi');
      let m;
      while ((m = regex.exec(upBodyCode)) !== null) {
        const lineNumber = upBodyCode.substring(0, m.index).split('\n').length;
        if (check.severity === 'error') {
          report.error(file, lineNumber, check.message);
        } else {
          report.warn(file, lineNumber, check.message);
        }
      }
    }
  }

  // Check raw SQL calls (pgm.sql(...)).
  const sqlCalls = content.matchAll(/pgm\.sql\(`([\s\S]*?)`\)/g);
  for (const sqlMatch of sqlCalls) {
    const sql = sqlMatch[1];
    for (const check of CHECKS) {
      if (check.phase !== 'up') continue;
      const regex = new RegExp(check.pattern.source, 'gi');
      if (regex.test(sql)) {
        if (check.severity === 'error') {
          report.error(file, 0, `[in pgm.sql()] ${check.message}`);
        } else {
          report.warn(file, 0, `[in pgm.sql()] ${check.message}`);
        }
      }
    }
  }
}

/**
 * Check that contract migrations exist for expand migrations that add state.
 */
function checkExpandContractPairs(files, report) {
  const expandFiles = files.filter(f => f.includes('expand') || f.includes('add_'));
  const contractFiles = files.filter(f => f.includes('contract') || f.includes('drop_'));

  const contractTargets = new Set(
    contractFiles.map(f => {
      // Extract the target entity from filename: 005_contract_drop_X -> X
      const match = f.match(/drop_(\w+)/);
      return match ? match[1] : null;
    }),
  );

  for (const f of expandFiles) {
    const match = f.match(/add_(\w+)/);
    if (match) {
      const target = match[1];
      if (!contractTargets.has(target)) {
        report.warn(
          f,
          0,
          `Expand migration adds "${target}" but no contract migration to remove it was found. ` +
            `Every expand must have a corresponding contract.`,
        );
      }
    }
  }
}

/**
 * Validate that migration filenames follow the timestamp convention.
 */
function checkFilenameConvention(files, report) {
  for (const f of files) {
    if (!/^\d{6,}_/.test(f)) {
      report.warn(
        f,
        0,
        'Migration filename should start with a numeric timestamp prefix (e.g. 20260101000000_name.js) for correct ordering.',
      );
    }
  }
}

/**
 * Scan a migrations directory. Exported so the rules can be tested against
 * fixture directories; the CLI below passes the repository's migrations/.
 *
 * @param {string} [dir] directory holding `.js` and `.sql` migrations
 * @returns {Promise<{issues: Array<{severity: string, file: string, line: number, message: string}>, files: string[]}>}
 */
export async function checkMigrations(dir = MIGRATIONS_DIR) {
  const issues = [];
  const report = {
    warn: (file, line, message) => issues.push({ severity: 'warning', file, line, message }),
    error: (file, line, message) => issues.push({ severity: 'error', file, line, message }),
  };

  const entries = await readdir(dir);
  const files = entries.filter(f => MIGRATION_EXTENSIONS.some(ext => f.endsWith(ext))).sort();

  for (const file of files) {
    const content = await readFile(join(dir, file), 'utf8');
    if (file.endsWith('.sql')) {
      checkSqlMigration(file, content, report);
    } else {
      checkJsMigration(file, content, report);
    }
  }

  checkExpandContractPairs(files, report);
  checkFilenameConvention(files, report);

  return { issues, files };
}

async function main(dir = MIGRATIONS_DIR) {
  const { issues, files } = await checkMigrations(dir);

  if (files.length === 0) {
    console.log('No migration files found. Nothing to check.');
    process.exit(0);
  }

  // ── Report ──────────────────────────────────────────────────────────────

  if (issues.length === 0) {
    console.log(`Migration compatibility check passed (${files.length} files scanned).`);
    process.exit(0);
  }

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  console.error(`\nMigration compatibility issues found:`);
  console.error('─'.repeat(70));

  for (const issue of issues) {
    const prefix = issue.severity === 'error' ? 'ERROR' : 'WARN ';
    const loc = issue.line > 0 ? `:${issue.line}` : '';
    console.error(`  ${prefix}  ${issue.file}${loc} — ${issue.message}`);
  }

  console.error('─'.repeat(70));
  console.error(`${errors.length} error(s), ${warnings.length} warning(s)`);

  if (errors.length > 0) {
    console.error('\nBlocking: fix the errors above before merging. See docs/MIGRATIONS.md.');
    process.exit(1);
  }

  console.error('\nNon-blocking: review the warnings above.');
  process.exit(0);
}

// Only run the CLI when executed directly; importing the module (in tests)
// must not scan the repo or call process.exit().
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // Optional first argument: a migrations directory to scan instead of ./migrations.
  const dir = process.argv[2] ? resolve(process.argv[2]) : MIGRATIONS_DIR;
  main(dir).catch(err => {
    console.error('Migration check failed:', err);
    process.exit(1);
  });
}
