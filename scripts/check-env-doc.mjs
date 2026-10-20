#!/usr/bin/env node
/**
 * Keeps .env.example honest — in both directions.
 *
 * WHY THIS EXISTS. .env.example is the operator's setup reference — the file
 * they copy and fill in before first boot. If it drifts from what the code
 * actually reads, the undocumented half is invisible: defaults silently apply,
 * and for the spend-limit variables that is a money question rather than a
 * convenience one. The other half drifts just as quietly: a name documented
 * there that no code reads is a promise the service never keeps (#504 added
 * STELLAR_SECRET — a name nothing reads — and this check waved it through,
 * because "documented but not detected" was informational by design).
 *
 * Both directions are fatal:
 *
 *   read in src/ but missing from .env.example  → fail (issue #144)
 *   documented in .env.example but never read   → fail, unless allowlisted
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
 * THE ALLOWLIST. A few real reads are computed: the name reaches the
 * environment through an argument (`env[pluralKey]`, `env[key]`, `env[k]`,
 * `process.env[name]`), so the grep above cannot see them. Each such name is
 * listed in ALLOWLIST below with the src/ line that reads it, and every entry
 * is verified when this script runs — the cited snippet must still be in the
 * cited file — so the list cannot quietly outlive the code it excuses. A name
 * that no code reads at all is not allowlisted: it is dead, and the fix is to
 * delete it from .env.example.
 *
 * Usage:
 *   node scripts/check-env-doc.mjs            # check this repo
 *   node scripts/check-env-doc.mjs --root DIR # check a different checkout
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = args.indexOf('--root');
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = flag !== -1 ? resolve(args[flag + 1]) : repoRoot;

/**
 * The tree the allowlist's citations are checked against: the tree being
 * scanned when it has a src/ directory (this repository, and a fixture that
 * mimics one), and this checker's own checkout otherwise. The allowlist
 * describes this repository's code, so a citation is resolved here even when
 * --root points somewhere else.
 */
const referenceRoot = existsSync(join(root, 'src')) ? root : repoRoot;

const ENV_READ_RE = /env\.([A-Z][A-Z0-9_]{2,})/g;
const EXAMPLE_KEY_RE = /^\s*#?\s*([A-Z][A-Z0-9_]{2,})(?==)/;

/**
 * Bracket-literal reads, counted ONLY when verifying allowlist entries. The
 * primary read set deliberately stays on ENV_READ_RE: widening it would move a
 * documented name out of the dead list, which loosens the guard this script
 * exists to tighten.
 */
const ENV_BRACKET_READ_RE = /env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g;

/**
 * Documented names that the src/ grep above cannot see, each with the reason
 * it is exempt and the source line that proves it.
 *
 *   kind 'computed'     the name reaches the environment through an argument
 *                       the grep cannot follow, so `file` + `snippet` cite the
 *                       code that reads it.
 *   kind 'compose-only' the name is consumed by the deployment stack and by
 *                       no code in src/ or scripts/.
 *   kind 'script-only'  the name is read only by an operator script under
 *                       scripts/ (never by the service in src/), so `file` +
 *                       `snippet` cite the script's read.
 *
 * `why` is printed whenever an entry is used, so a CI log says why the name
 * is exempt and where to look. `pattern` marks a family whose names are
 * unbounded (the per-key rate-limit overrides), so any member of the family
 * may be documented at any time.
 *
 * Every entry is checked against the code when this script runs:
 *   * the cited snippet must still be in the cited file — otherwise the entry
 *     has outlived the code it excuses and CI fails;
 *   * a 'computed' name must not have become directly readable — otherwise the
 *     entry is no longer needed;
 *   * a 'compose-only' name must not be read in src/ or scripts/ — otherwise it
 *     is not compose-only, and its citation must not be a service source file.
 */
const ALLOWLIST = [
  {
    names: ['FACILITATOR_SECRET'],
    kind: 'computed',
    file: 'src/config.js',
    snippet: "'FACILITATOR_SECRET'",
    why: 'the signer secret is read through a computed key: parseSecrets() reads env[pluralKey] ?? env[singularKey]',
  },
  {
    names: ['FACILITATOR_SECRETS'],
    kind: 'computed',
    file: 'src/config.js',
    snippet: "'FACILITATOR_SECRETS'",
    why: 'the signer secret list is read through the same computed key as the singular secret',
  },
  {
    names: ['FACILITATOR_SECRET_PUBNET'],
    kind: 'computed',
    file: 'src/config.js',
    snippet: "'FACILITATOR_SECRET_PUBNET'",
    why: 'the pubnet signer secret is read through the same computed key as the testnet one',
  },
  {
    names: ['FACILITATOR_SECRETS_PUBNET'],
    kind: 'computed',
    file: 'src/config.js',
    snippet: "'FACILITATOR_SECRETS_PUBNET'",
    why: 'the pubnet signer secret list is read through the same computed key as the testnet one',
  },
  {
    names: ['FEE_BUMP_SECRET'],
    kind: 'computed',
    file: 'src/config.js',
    snippet: "'FEE_BUMP_SECRET'",
    why: 'the fee-bump secret is read through a computed key: parseOptionalSecret() reads env[key]',
  },
  {
    names: ['FEE_BUMP_SECRET_PUBNET'],
    kind: 'computed',
    file: 'src/config.js',
    snippet: "'FEE_BUMP_SECRET_PUBNET'",
    why: 'the pubnet fee-bump secret is read through the same computed key',
  },
  {
    names: ['MAX_FEE_PER_CALL_STROOPS'],
    kind: 'computed',
    file: 'src/mcp/cli.js',
    snippet: "'MAX_FEE_PER_CALL_STROOPS'",
    why: 'the MCP per-call spend cap is read through a computed key: spendCapFromEnv() reads process.env[name]',
  },
  {
    names: ['MAX_SESSION_SPEND_STROOPS'],
    kind: 'computed',
    file: 'src/mcp/cli.js',
    snippet: "'MAX_SESSION_SPEND_STROOPS'",
    why: 'the MCP per-session spend cap is read through the same computed key',
  },
  {
    label: 'RATE_LIMIT_*',
    pattern: /^RATE_LIMIT_[A-Z0-9_]+$/,
    kind: 'computed',
    file: 'src/config.js',
    snippet: "startsWith('RATE_LIMIT_')",
    why: 'per-key rate-limit overrides are unbounded: the loader walks the environment and reads every name starting with RATE_LIMIT_ as env[k]',
  },
  {
    names: ['POSTGRES_PASSWORD'],
    kind: 'compose-only',
    file: 'docker-compose.yml',
    snippet: 'POSTGRES_PASSWORD',
    why: 'compose-only: docker-compose.yml consumes it for the db service and for DATABASE_URL; no src/ or scripts/ code reads it',
  },
  {
    names: ['POSTGRES_USER'],
    kind: 'compose-only',
    file: 'docker-compose.yml',
    snippet: 'POSTGRES_USER',
    why: 'compose-only: docker-compose.yml consumes it for the db service and for DATABASE_URL; no src/ or scripts/ code reads it',
  },
  {
    names: ['POSTGRES_DB'],
    kind: 'compose-only',
    file: 'docker-compose.yml',
    snippet: 'POSTGRES_DB',
    why: 'compose-only: docker-compose.yml consumes it for the db service and for DATABASE_URL; no src/ or scripts/ code reads it',
  },
  {
    names: ['MERCHANT_ADDRESS'],
    kind: 'script-only',
    file: 'scripts/e2e.mjs',
    snippet: 'process.env.MERCHANT_ADDRESS',
    why: 'script-only: the e2e harness reads it for the payee address; the service in src/ never does',
  },
  {
    names: ['RESOURCE_PORT'],
    kind: 'script-only',
    file: 'scripts/e2e.mjs',
    snippet: 'process.env.RESOURCE_PORT',
    why: 'script-only: the e2e harness reads it for the resource server port; the service in src/ never does',
  },
  {
    names: ['VERBOSE'],
    kind: 'script-only',
    file: 'scripts/e2e.mjs',
    snippet: 'process.env.VERBOSE',
    why: 'script-only: the e2e harness reads it to print full errors; the service in src/ never does',
  },
  {
    names: ['SMART_ACCOUNT_WASM'],
    kind: 'script-only',
    file: 'scripts/e2e-smart-account.mjs',
    snippet: 'process.env.SMART_ACCOUNT_WASM',
    why: 'script-only: npm run e2e:smart-account reads it for the contract wasm path; the service in src/ never does',
  },
];

/** Recursively lists the .js/.mjs/.cjs files under dir. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
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
  if (!existsSync(path)) {
    console.error(`FAIL: no .env.example found at ${path}.`);
    process.exit(1);
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(EXAMPLE_KEY_RE);
    if (match) documented.add(match[1]);
  }
  return documented;
}

/**
 * Every env-style name read under a directory, counting bracket literals too.
 * Used only to verify allowlist entries — see ENV_BRACKET_READ_RE.
 */
function readsIn(dir) {
  const names = new Set();
  for (const file of walk(dir)) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(ENV_READ_RE)) names.add(match[1]);
    for (const match of content.matchAll(ENV_BRACKET_READ_RE)) names.add(match[1]);
  }
  return names;
}

/** Reads a repo-relative file from the scanned tree, then from this checkout. */
function readReferenceFile(rel) {
  for (const base of [root, repoRoot]) {
    const path = join(base, rel);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return null;
}

/** Whether an allowlist entry covers a documented name. */
function entryMatches(entry, name) {
  return entry.pattern ? entry.pattern.test(name) : entry.names.includes(name);
}

/** A human-readable name for an allowlist entry, for messages. */
function entryLabel(entry) {
  return entry.label ?? entry.names.join(', ');
}

/**
 * Where an entry's cited snippet lives now. A citation that no longer
 * resolves is the entry's expiry date: the code it excused has changed shape,
 * and the entry has to be re-justified or removed.
 */
function locateCitation(entry) {
  const content = readReferenceFile(entry.file);
  if (content === null) {
    return { problem: `the cited file ${entry.file} does not exist` };
  }
  const index = content.indexOf(entry.snippet);
  if (index === -1) {
    return { problem: `${entry.file} no longer contains \`${entry.snippet}\`` };
  }
  return { line: content.slice(0, index).split('\n').length };
}

const read = readInSrc();
const documented = documentedInExample();

const readSet = new Set(read);
const missing = read.filter(key => !documented.has(key));
const dead = [...documented].filter(key => !readSet.has(key)).sort();

/**
 * The documented names that no code reads, split by whether an allowlist entry
 * excuses them.
 */
const excused = [];
const unexcused = [];
for (const name of dead) {
  const entry = ALLOWLIST.find(candidate => entryMatches(candidate, name));
  if (entry) excused.push({ name, entry });
  else unexcused.push(name);
}

/** The service's own reads, used to check that the allowlist is still true. */
const srcReads = readsIn(join(referenceRoot, 'src'));
const serviceReads = new Set([...srcReads, ...readsIn(join(referenceRoot, 'scripts'))]);

/** Allowlist entries whose citation no longer holds, and why. */
const allowlistProblems = [];
/** Where each verified entry's snippet lives, for the summary below. */
const citations = new Map();

for (const entry of ALLOWLIST) {
  const label = entryLabel(entry);
  const citation = locateCitation(entry);
  if (citation.problem) {
    allowlistProblems.push(
      `${label}: ${citation.problem}. Re-justify the entry, or remove it if the code no longer reads the name.`,
    );
    continue;
  }
  citations.set(entry, citation);

  if (entry.kind === 'compose-only') {
    if (entry.file.startsWith('src/') || entry.file.startsWith('scripts/')) {
      allowlistProblems.push(
        `${label}: a compose-only entry must cite a deployment file, not ${entry.file}.`,
      );
    }
    for (const name of entry.names) {
      if (serviceReads.has(name)) {
        allowlistProblems.push(
          `${label}: ${name} is read in src/ or scripts/ now, so it is no longer compose-only.`,
        );
      }
    }
  } else {
    for (const name of entry.names ?? []) {
      if (srcReads.has(name)) {
        allowlistProblems.push(
          `${label}: ${name} is read directly in src/ now, so this entry is no longer needed.`,
        );
      }
    }
  }
}

console.log(
  `src/ reads ${read.length} env variable(s); .env.example documents ${documented.size}.`,
);

const problems = [];

if (missing.length > 0) {
  problems.push({
    title: 'these variables are read in src/ but missing from .env.example:',
    lines: missing.map(key => `  - ${key}`),
    hint: 'Add each with a comment covering what it does, its default, and when to change it.',
  });
}

if (allowlistProblems.length > 0) {
  problems.push({
    title: 'the allowlist in this script no longer matches the code:',
    lines: allowlistProblems.map(problem => `  - ${problem}`),
    hint: 'Update each citation, or remove the entry — an allowlist entry must never outlive the code it excuses.',
  });
}

if (unexcused.length > 0) {
  problems.push({
    title: 'these variables are documented in .env.example but no code in src/ reads them:',
    lines: unexcused.map(key => `  - ${key}`),
    hint: 'Remove each from .env.example, or — if the name is read through a computed key the src/ grep cannot follow — add an individually justified entry to ALLOWLIST in scripts/check-env-doc.mjs.',
  });
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`\nFAIL: ${problem.title}`);
    for (const line of problem.lines) console.error(line);
    console.error(`\n${problem.hint}`);
  }
  process.exit(1);
}

if (excused.length > 0) {
  console.log(
    '\nDocumented but not directly readable (allowlisted, with the code that reads them):',
  );
  for (const { name, entry } of excused) {
    console.log(`  - ${name} — ${entry.why} [${entry.file}:${citations.get(entry).line}]`);
  }
}

console.log(
  'OK: every variable read in src/ is documented in .env.example, and every documented variable is read or allowlisted.',
);
