#!/usr/bin/env node
/**
 * Keeps .env.example honest: every environment variable read in src/ must be
 * documented there, and every name documented there must be read (or explicitly
 * excused) in src/.
 *
 * WHY THIS EXISTS. .env.example is the operator's setup reference — the file
 * they copy and fill in before first boot. If it drifts from what the code
 * actually reads, the undocumented half is invisible: defaults silently apply,
 * and for the spend-limit variables that is a money question rather than a
 * convenience one. This check turns both directions of drift into CI failures:
 *   * read in src/ but missing from .env.example  → fatal (unchanged)
 *   * documented in .env.example but never read   → fatal, unless on DECLARED_DEAD
 *
 * What counts as "read": any `env.`-style access to an UPPER_CASE name in
 * src/ (`process.env.X`, and config.js's `env.X` parameter), the same
 * extraction the issue that started this used:
 *
 *   grep -rhoP 'env\.\K[A-Z][A-Z0-9_]{2,}' src/ | sort -u
 *
 * Several real reads use bracket/computed access (`env[pluralKey]`,
 * `env[key]`, `env[k]`, `process.env[name]`) that the lexical regex cannot
 * resolve. Those dynamic prefixes are declared in DECLARED_DEAD below, each
 * with an individual src/ citation, so the allowlist cannot quietly grow back
 * into a blind spot. Names that are documented only for docker-compose (never
 * read in src/ or scripts/) are excused as 'compose-only'.
 *
 * What counts as "documented": any key written before an `=` in .env.example,
 * whether the line is commented out or live — the file's convention is to show
 * unset defaults as `# KEY=value`.
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

/**
 * Dynamic prefixes the lexical grep cannot resolve, each individually justified
 * with a src/ citation (config.js line numbers) or 'compose-only'. This is the
 * only escape hatch for documented-but-dead names; it is not a blind spot
 * because every entry names its source.
 */
const DECLARED_DEAD = new Map([
  [
    'FACILITATOR_SECRET*',
    'computed bracket read: src/config.js:52 `env[pluralKey] ?? env[singularKey]` ' +
      '(parseSecrets), called at :109 (testnet) and :263-267 (pubnet)',
  ],
  [
    'FEE_BUMP_SECRET*',
    'computed bracket read: src/config.js:82 `env[key]?.trim()` ' +
      '(parseOptionalSecret), called at :110 (testnet) and :268 (pubnet)',
  ],
  [
    'RATE_LIMIT_*',
    'computed per-key read: src/config.js:249-252 `Object.keys(env)` loop reads ' +
      '`env[k]` at :258',
  ],
  [
    'MAX_FEE_PER_CALL_STROOPS',
    'computed bracket read: src/mcp/cli.js:66 `process.env[name]` (spendCapFromEnv)',
  ],
  [
    'MAX_SESSION_SPEND_STROOPS',
    'computed bracket read: src/mcp/cli.js:66 `process.env[name]` (spendCapFromEnv)',
  ],
  [
    'POSTGRES_DB',
    'compose-only: docker-compose/orchestrator credential; never read in src/ or scripts/',
  ],
  [
    'POSTGRES_PASSWORD',
    'compose-only: docker-compose/orchestrator credential; never read in src/ or scripts/',
  ],
  [
    'POSTGRES_USER',
    'compose-only: docker-compose/orchestrator credential; never read in src/ or scripts/',
  ],
  [
    'AUDIT_LOG_FILE',
    'not yet read: documented but drift (#554); name appears only in JSDoc at ' +
      'src/audit.js:40 and :56; audit file sink not wired',
  ],
  [
    'MERCHANT_ADDRESS',
    'documented in .env.example for scripts/e2e.mjs:50; not read in src/ or scripts/ other than the e2e test harness default',
  ],
  [
    'RESOURCE_PORT',
    'documented in .env.example for scripts/e2e.mjs:52; not read in src/ or scripts/ other than the e2e test harness default',
  ],
  [
    'VERBOSE',
    'documented in .env.example for scripts/e2e.mjs:221; not read in src/ or scripts/ other than the e2e test harness default',
  ],
  [
    'SMART_ACCOUNT_WASM',
    'documented in .env.example for scripts/e2e:smart-account; not read in src/ or other scripts',
  ],
]);

/** True when `key` matches an exact allowlist entry or a `PREFIX*` family. */
function isDeclaredDead(key) {
  if (DECLARED_DEAD.has(key)) return true;
  for (const pattern of DECLARED_DEAD.keys()) {
    if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/** Justification text for a declared-dead key, or undefined. */
function declaredDeadJustification(key) {
  if (DECLARED_DEAD.has(key)) return DECLARED_DEAD.get(key);
  for (const pattern of DECLARED_DEAD.keys()) {
    if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) {
      return DECLARED_DEAD.get(pattern);
    }
  }
  return undefined;
}

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

const declaredDead = extra.filter(key => isDeclaredDead(key));
const undeclaredDead = extra.filter(key => !isDeclaredDead(key));

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

if (undeclaredDead.length > 0) {
  console.error(
    '\nFAIL: these variables are documented in .env.example but never read in src/ ' +
      '(and are not on the declared-dead allowlist):',
  );
  for (const key of undeclaredDead) {
    console.error(`  - ${key}`);
    const why = declaredDeadJustification(key);
    if (why) console.error(`      allowlist justification: ${why}`);
  }
  console.error(
    '\nRemove the entry from .env.example, or add an individually justified, cited ' +
      'allowlist entry in scripts/check-env-doc.mjs.',
  );
  process.exit(1);
}

if (declaredDead.length > 0) {
  console.log('\nDocumented but never read (declared dead, excused):');
  for (const key of declaredDead) {
    console.log(`  - ${key} — ${declaredDeadJustification(key)}`);
  }
}

console.log(
  'OK: every variable read in src/ is documented in .env.example, and every ' +
    'documented variable is either read or explicitly excused.',
);
