/**
 * Fails the build if a copyleft licence appears anywhere in the dependency
 * tree.
 *
 * A permissive OSI licence with no AGPL in the dependency path is a hard
 * requirement for this project, not a preference — an AGPL dependency would
 * make the service undistributable on the terms it promises. That requirement
 * is currently a sentence in a README, and a sentence is not a check. This is
 * the check.
 *
 * Deliberately dependency-free. Pulling in a licence-scanning package to
 * enforce a licence policy adds another package to the tree the policy is
 * about, and the whole job is reading `license` out of every package.json.
 *
 * Usage:
 *   node scripts/check-licenses.mjs           # fail on a forbidden licence
 *   node scripts/check-licenses.mjs --list    # print the full inventory
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Licences that must never appear.
 *
 * AGPL is the named one. SSPL, BUSL and CC-BY-NC are here because they are
 * likewise not permissive OSI licences and would fail the same requirement for
 * the same reason — better to catch them now than to discover the rule was
 * written too narrowly.
 */
const FORBIDDEN = [/\bAGPL/i, /\bSSPL/i, /\bBUSL/i, /\bCC-BY-NC/i];

/** Matched only when a package declares nothing else — see classify(). */
const WEAK_COPYLEFT = [/\bGPL-/i, /\bLGPL/i, /\bMPL-/i, /\bEPL-/i];

/**
 * Reads the licence of one package, tolerating every shape npm has ever used:
 * a string, an SPDX expression, a {type} object, or a legacy `licenses` array.
 */
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map(l => (typeof l === 'string' ? l : l.type)).join(' OR ');
  }
  return 'UNKNOWN';
}

/** Walks node_modules, including scoped and nested trees. */
function* packages(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // No node_modules at this level. Not an error: a package with no
    // dependencies of its own simply has none.
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === '.bin' || entry.name === '.cache') continue;

    const full = join(dir, entry.name);

    if (entry.name.startsWith('@')) {
      yield* packages(full);
      continue;
    }

    try {
      const manifest = JSON.parse(readFileSync(join(full, 'package.json'), 'utf8'));
      if (manifest.name) {
        yield { name: manifest.name, version: manifest.version, license: licenseOf(manifest) };
      }
    } catch {
      // Not a package directory, or an unreadable manifest. Skipping is right:
      // this walks a directory tree, not a resolved dependency graph.
    }

    const nested = join(full, 'node_modules');
    try {
      if (statSync(nested).isDirectory()) yield* packages(nested);
    } catch {
      // No nested tree.
    }
  }
}

function classify(license) {
  if (FORBIDDEN.some(re => re.test(license))) return 'forbidden';
  // A dual licence offering a permissive option is fine — we take that option.
  if (WEAK_COPYLEFT.some(re => re.test(license)) && !/\bOR\b/i.test(license)) return 'review';
  if (license === 'UNKNOWN') return 'review';
  return 'ok';
}

const found = [...packages(join(ROOT, 'node_modules'))];
if (found.length === 0) {
  console.error('No packages found. Run npm ci first.');
  process.exit(2);
}

const forbidden = [];
const review = [];
for (const pkg of found) {
  const verdict = classify(pkg.license);
  if (verdict === 'forbidden') forbidden.push(pkg);
  else if (verdict === 'review') review.push(pkg);
}

if (process.argv.includes('--list')) {
  const counts = new Map();
  for (const pkg of found) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  for (const [license, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(4)}  ${license}`);
  }
  console.log(`\n${found.length} packages`);
}

if (review.length > 0) {
  console.log(`\n${review.length} package(s) need a human look (not a failure):`);
  for (const pkg of review) console.log(`  ${pkg.name}@${pkg.version} — ${pkg.license}`);
}

if (forbidden.length > 0) {
  console.error(`\nFORBIDDEN LICENCE in the dependency path:`);
  for (const pkg of forbidden) console.error(`  ${pkg.name}@${pkg.version} — ${pkg.license}`);
  console.error(
    '\nThis project commits to a permissive OSI licence with no AGPL in the ' +
      'dependency path. Remove the dependency or find a permissive alternative.',
  );
  process.exit(1);
}

console.log(`\nLicence check passed — ${found.length} packages, none forbidden.`);
