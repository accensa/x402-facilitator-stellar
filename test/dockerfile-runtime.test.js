/**
 * The image must run the Node major version CI tests (#742).
 *
 * Both Dockerfile stages were pinned to `node:20-alpine` while the only CI job
 * ran Node 22 (.github/workflows/ci.yml). The artifact deployed to servers was
 * therefore an engine version no automated test executed: a V8 or crypto
 * difference between 20 and 22 could pass every check and still fail in
 * production.
 *
 * These assertions are static because building the image in the unit suite
 * would need a Docker daemon and a network pull. They pin the two things the
 * issue asks for: the runtime matches CI's major, and every stage names an
 * explicit node:<version>-alpine@sha256:... reference so neither stage can
 * drift back to a floating tag or a different digest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8').replace(/\r/g, '');
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r/g, '');

/**
 * Every `FROM` image reference, in file order. Build flags such as
 * `--platform=...` are dropped, and a trailing `AS <stage>` is ignored.
 */
function baseImages() {
  return [...dockerfile.matchAll(/^\s*FROM\s+(.+)$/gim)].map(match => {
    const tokens = match[1]
      .trim()
      .split(/\s+/)
      .filter(token => !token.startsWith('--'));
    return tokens[0];
  });
}

/** The single node major CI runs. Fails via the caller's assertion if absent. */
function ciNodeMajor() {
  const versions = [...ci.matchAll(/^\s*node-version:\s*['"]?([^'"\s#]+)['"]?/gim)].map(
    match => match[1],
  );
  assert.equal(
    versions.length,
    1,
    `.github/workflows/ci.yml must pin exactly one node-version, found ${JSON.stringify(versions)}`,
  );
  assert.match(versions[0], /^\d+$/, 'CI node-version must be a plain major version, not a range');
  return Number(versions[0]);
}

const images = baseImages();

test('the Dockerfile builds every stage from node', () => {
  assert.ok(images.length >= 2, 'expected a builder stage and a runtime stage');
  for (const image of images) {
    assert.match(
      image,
      /^node:/,
      `Dockerfile stage uses ${image}; the service supports the Node runtime CI tests, not an arbitrary base`,
    );
  }
});

test('every stage is pinned to the same explicit node major as CI', () => {
  const major = ciNodeMajor();

  for (const image of images) {
    const tag = image.split('@')[0].slice('node:'.length);
    assert.match(
      tag,
      new RegExp(`^${major}-alpine$`),
      `Dockerfile stage runs node:${tag} but CI runs Node ${major}; the image would ship an ` +
        'engine version no CI job exercises (#742)',
    );
  }

  assert.equal(
    new Set(images).size,
    1,
    'builder and runtime stages must use the identical base reference so they cannot diverge',
  );
});

test('every stage pins the image by sha256 digest', () => {
  for (const image of images) {
    const reference = image.split('@');
    assert.equal(reference.length, 2, `${image} is not digest-pinned; a floating tag moves`);
    assert.match(reference[1], /^sha256:[0-9a-f]{64}$/, `${image} has a malformed digest`);
  }
});

test('the alpine variant is used so the HEALTHCHECK wget exists', () => {
  // The runtime HEALTHCHECK shells out to wget, which busybox supplies in the
  // alpine variant. A move to a distroless or slim base would break it silently
  // because Docker only reports an unhealthy container.
  for (const image of images) {
    assert.match(image, /-alpine@sha256:/, `${image} must stay on the alpine variant (#742)`);
  }
});
