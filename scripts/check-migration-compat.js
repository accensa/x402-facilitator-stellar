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
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const ISSUES = [];

function warn(file, line, message) {
  ISSUES.push({ severity: 'warning', file, line, message });
}

function error(file, line, message) {
  ISSUES.push({ severity: 'error', file, line, message });
}

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
    pattern: /\bRENAME\s+(TABLE|COLUMN)\b/gi,
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
 * Check that contract migrations exist for expand migrations that add state.
 */
function checkExpandContractPairs(files) {
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
        warn(
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
function checkFilenameConvention(files) {
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    if (!/^\d{6,}_/.test(f)) {
      warn(
        f,
        0,
        'Migration filename should start with a numeric timestamp prefix (e.g. 20260101000000_name.js) for correct ordering.',
      );
    }
  }
}

async function main() {
  const entries = await readdir(MIGRATIONS_DIR);
  const jsFiles = entries.filter(f => f.endsWith('.js')).sort();

  if (jsFiles.length === 0) {
    console.log('No migration files found. Nothing to check.');
    process.exit(0);
  }

  for (const file of jsFiles) {
    const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

    // Determine the migration phase from exports.
    const hasUp = content.includes('export const up');
    const hasDown = content.includes('export const down');

    if (!hasUp) {
      warn(file, 0, 'Migration file is missing an up() export.');
    }
    if (!hasDown) {
      warn(file, 0, 'Migration file is missing a down() export (rollback).');
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
            error(file, lineNumber, check.message);
          } else {
            warn(file, lineNumber, check.message);
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
            error(file, 0, `[in pgm.sql()] ${check.message}`);
          } else {
            warn(file, 0, `[in pgm.sql()] ${check.message}`);
          }
        }
      }
    }
  }

  checkExpandContractPairs(jsFiles);
  checkFilenameConvention(jsFiles);

  // ── Report ──────────────────────────────────────────────────────────────

  if (ISSUES.length === 0) {
    console.log(`Migration compatibility check passed (${jsFiles.length} files scanned).`);
    process.exit(0);
  }

  const errors = ISSUES.filter(i => i.severity === 'error');
  const warnings = ISSUES.filter(i => i.severity === 'warning');

  console.error(`\nMigration compatibility issues found:`);
  console.error('─'.repeat(70));

  for (const issue of ISSUES) {
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

main().catch(err => {
  console.error('Migration check failed:', err);
  process.exit(1);
});
