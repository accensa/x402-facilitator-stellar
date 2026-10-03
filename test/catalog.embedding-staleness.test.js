/**
 * A vector describes the text it was computed from, and nothing else (#220).
 *
 * `upsertResource` builds the new entry as `{...existing, ...resource}`, so a
 * resource whose text fields change inherits the *previous* vector. If that
 * vector survived, the dense search leg would go on ranking the listing by
 * content that no longer exists — and it would do so silently, because a failed
 * re-embed only logs a warning. These tests pin the two halves of the fix: the
 * stale vector is dropped synchronously on a content change, and a failed
 * re-embed leaves it dropped rather than restoring it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogStore } from '../src/catalog/memory.js';

const RESOURCE = {
  url: 'http://api.example/paid',
  serviceName: 'weather',
  description: 'current conditions',
  payTo: 'GPAYTO',
  network: 'stellar:testnet',
};

const VECTOR = [1, 0, 0];

/**
 * A store with the provider attached, as `catalog.search.test.js` does — the
 * real `EmbeddingClient` does HTTP, so the provider is replaced at the client
 * boundary and everything above it is the real implementation.
 */
function providerStore({ embed } = {}) {
  const store = new MemoryCatalogStore();
  store.embeddingClient.url = 'https://embeddings.test/vectors';
  store.embeddingClient.embed = embed ?? (async () => VECTOR);
  return store;
}

test('a first upsert embeds the resource and records what the vector describes', async () => {
  const store = providerStore();
  await store.upsertResource({ ...RESOURCE }, 'settle');
  await store.flush();

  const entry = store.resources.get(`${RESOURCE.url}::`);
  assert.deepEqual(entry.embedding, VECTOR);
  assert.ok(entry.embedding_source, 'the fingerprint of the embedded text must be recorded');
});

test('changing the content drops the old vector before the re-embed lands', async () => {
  const store = providerStore();
  await store.upsertResource({ ...RESOURCE }, 'settle');
  await store.flush();
  assert.deepEqual(store.resources.get(`${RESOURCE.url}::`).embedding, VECTOR);

  // Swap in a blocking provider so the window between "content changed" and
  // "new vector computed" is observable.
  let release;
  store.embeddingClient.embed = () =>
    new Promise(resolve => {
      release = () => resolve([0, 1, 0]);
    });

  const updated = await store.upsertResource(
    { ...RESOURCE, description: 'a completely different description' },
    'settle',
  );

  // The drop is synchronous: by the time upsert returns, the vector that
  // described the *old* text is gone. This is the property a durable store
  // depends on — the entry it persists on this upsert is already invalidated.
  assert.equal(updated.embedding, undefined, 'stale vector must be dropped synchronously');
  assert.equal(updated.embedding_source, undefined);

  release();
  await store.flush();
  assert.deepEqual(store.resources.get(`${RESOURCE.url}::`).embedding, [0, 1, 0]);
});

test('an unrelated field change keeps the vector', async () => {
  let calls = 0;
  const store = providerStore({
    embed: async () => {
      calls += 1;
      return VECTOR;
    },
  });

  await store.upsertResource({ ...RESOURCE }, 'settle');
  await store.flush();
  assert.equal(calls, 1);

  // A verify re-touching a settled listing changes only bookkeeping fields
  // (source/last_seen_at/expires_at), which do not compose into the document.
  await store.upsertResource({ ...RESOURCE }, 'verify');
  await store.flush();

  assert.equal(calls, 1, 'unchanged text must not be re-embedded');
  assert.deepEqual(store.resources.get(`${RESOURCE.url}::`).embedding, VECTOR);
});

test('a failed re-embed leaves the stale vector dropped', async () => {
  const store = providerStore();
  await store.upsertResource({ ...RESOURCE }, 'settle');
  await store.flush();
  assert.deepEqual(store.resources.get(`${RESOURCE.url}::`).embedding, VECTOR);

  store.embeddingClient.embed = async () => {
    throw new Error('provider exploded');
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = msg => warnings.push(String(msg));
  try {
    await store.upsertResource({ ...RESOURCE, description: 'new text' }, 'settle');
    await store.flush();
  } finally {
    console.warn = originalWarn;
  }

  const entry = store.resources.get(`${RESOURCE.url}::`);
  assert.equal(entry.embedding, undefined, 'the old vector must not survive the failure');
  assert.equal(entry.embedding_source, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to re-embed/);
});

test('a failed re-embed of unchanged text keeps the vector that still describes it', async () => {
  const store = providerStore();
  await store.upsertResource({ ...RESOURCE }, 'settle');
  await store.flush();

  store.embeddingClient.embed = async () => {
    throw new Error('provider exploded');
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // Nothing composes to different text, so no embed is even attempted: the
    // inherited vector is still a description of this resource.
    await store.upsertResource({ ...RESOURCE }, 'verify');
    await store.flush();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(store.resources.get(`${RESOURCE.url}::`).embedding, VECTOR);
});

test('the fingerprint is a real 64-bit hash, not a length or a prefix', () => {
  const store = providerStore();
  // Two different texts of the same length must not share a fingerprint, and
  // nor must a reordering of the same characters.
  const a = store._documentFingerprint({ ...RESOURCE, description: 'abcdef' });
  const b = store._documentFingerprint({ ...RESOURCE, description: 'abcdeg' });
  const c = store._documentFingerprint({ ...RESOURCE, description: 'fedcba' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(store._documentFingerprint({ ...RESOURCE, description: 'abcdef' }), a);
});
