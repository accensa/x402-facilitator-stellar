#!/usr/bin/env node
/**
 * Keeps .env.example honest: every environment variable read in src/ must be
 * documented there.
 *
 * WHY THIS EXISTS. .env.example is the operator's setup reference — the file
 * they copy and fill in before first boot. If it drifts from what the code
 * actually reads, the undocumented half is invisible: defaults silently apply,
 * and for the spend-limit variables that is a money question rather than a
 * convenience one. This check turns the drift into a CI failure.
 *
 * What counts as "read": any `env.`-style access to an UPPER_CASE name in
 * src/ (`process.env.X`, and config.js's `env.X` parameter), the same
 * extraction the issue that started this used:
 *
 *   grep -rhoP 'env\.\K[A-Z][A-Z0-9_]{2,}' src/ | sort -u
 *
 * What counts as "documented": any key written before an `=` in .env.example,
 * whether the line is commented out or live — the file's convention is to show
 * unset defaults as `# KEY=value`.
 *
 * Deliberately one-directional: a variable documented but not detected by the
 * src/ grep is reported as informational, not an error, because several real
 * reads use bracket access (`env['FACILITATOR_SECRETS']` in config.js) and
 * would be false positives.
 *
 * Usage:
 *   node scripts/check-env-doc.mjs            # check this repo
 *   node scripts/check-env-doc.mjs --root DIR # check a different checkout
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = args.indexOf('--root');
const root =
  flag !== -1 ? resolve(args[flag + 1]) : resolve(fileURLToPath(new URL('..', import.meta.url)));

const ENV_READ_RE = /env\.([A-Z][A-Z0-9_]{2,})/g;
const EXAMPLE_KEY_RE = /^\s*#?\s*([A-Z][A-Z0-9_]{2,})(?==)/;

/** Recursively lists the .js/.mjs/.cjs files under dir. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every env-style variable name read anywhere under src/. */
function readInSrc() {
  const read = new Set();
  for (const file of walk(join(root, 'src'))) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(ENV_READ_RE)) {
      read.add(match[1]);
    }
  }
  return [...read].sort();
}

/** Every key written before an `=` in .env.example, commented or live. */
function documentedInExample() {
  const documented = new Set();
  const path = join(root, '.env.example');
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(EXAMPLE_KEY_RE);
    if (match) documented.add(match[1]);
  }
  return documented;
}

const read = readInSrc();
const documented = documentedInExample();

const missing = read.filter(key => !documented.has(key));
const extra = [...documented].filter(key => !read.includes(key)).sort();

console.log(
  `src/ reads ${read.length} env variable(s); .env.example documents ${documented.size}.`,
);

if (missing.length > 0) {
  console.error('\nFAIL: these variables are read in src/ but missing from .env.example:');
  for (const key of missing) console.error(`  - ${key}`);
  console.error(
    '\nAdd each with a comment covering what it does, its default, and when to change it.',
  );
  process.exit(1);
}

if (extra.length > 0) {
  console.log('\nDocumented in .env.example but not detected by the src/ grep (informational):');
  for (const key of extra) console.log(`  - ${key}`);
  console.log(
    '  (Bracket-style reads such as env["FACILITATOR_SECRETS"] are not matched by the grep.)',
  );
}

console.log('OK: every variable read in src/ is documented in .env.example.');
