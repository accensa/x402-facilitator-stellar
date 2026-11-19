/**
 * Pending idempotency claims expire (#711).
 *
 * MemoryIdempotencyStore.begin() marks a key in flight with `{ pending: true }`
 * and only complete()/fail() clear it. If the process dies in between, nothing
 * ever clears the claim and every retry of that key answers 409 forever. A
 * claim now carries `claimedAt`, and begin() treats a claim older than
 * `pendingTimeoutMs` as abandoned so a retry can take it over.
 *
 * The store takes `now` as a clock seam so these cases run without real waits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryIdempotencyStore, DEFAULT_PENDING_CLAIM_TIMEOUT_MS } from '../src/idempotency.js';

test('begin() records claimedAt when it marks a key pending', async () => {
  const store = new MemoryIdempotencyStore({ now: () => 1_000 });
  const claim = await store.begin('claim-timestamp');

  assert.equal(claim.replayed, false);
  assert.equal(claim.conflict, undefined);
  assert.deepEqual(store.records.get('claim-timestamp'), { pending: true, claimedAt: 1_000 });
});

test('an active pending claim keeps conflicting inside the timeout window', async () => {
  let clock = 0;
  const store = new MemoryIdempotencyStore({ pendingTimeoutMs: 60_000, now: () => clock });
  await store.begin('in-flight');

  clock = 59_999;
  const duplicate = await store.begin('in-flight');
  assert.equal(duplicate.conflict, true);
  assert.equal(duplicate.replayed, undefined);

  // The live claim is untouched: no response, original timestamp.
  assert.equal(store.records.get('in-flight').claimedAt, 0);
});

test('a stale pending claim is abandoned and a retry can re-acquire it', async () => {
  let clock = 1_000;
  const store = new MemoryIdempotencyStore({ pendingTimeoutMs: 5_000, now: () => clock });
  await store.begin('crashed-process');

  clock += 5_001;
  const takeover = await store.begin('crashed-process');
  assert.equal(takeover.conflict, undefined);
  assert.equal(takeover.replayed, false);
  assert.deepEqual(store.records.get('crashed-process'), { pending: true, claimedAt: 6_001 });

  // The takeover owns a fresh window: an immediate duplicate conflicts again.
  const duplicate = await store.begin('crashed-process');
  assert.equal(duplicate.conflict, true);
});

test('a claim exactly at the timeout boundary is still live', async () => {
  let clock = 0;
  const store = new MemoryIdempotencyStore({ pendingTimeoutMs: 5_000, now: () => clock });
  await store.begin('boundary');

  clock = 5_000;
  assert.equal((await store.begin('boundary')).conflict, true);

  clock = 5_001;
  assert.equal((await store.begin('boundary')).conflict, undefined);
});

test('completing a taken-over claim replays for later retries', async () => {
  let clock = 0;
  const store = new MemoryIdempotencyStore({ pendingTimeoutMs: 1_000, now: () => clock });
  await store.begin('takeover-complete');

  clock += 1_001;
  const takeover = await store.begin('takeover-complete');
  await store.complete(takeover.key, 200, { success: true, transaction: 'taken-over' });

  // A completed record never expires; the recorded response replays.
  clock += 60_000;
  const replay = await store.begin('takeover-complete');
  assert.equal(replay.replayed, true);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.response.transaction, 'taken-over');
});

test('the pending timeout is configurable per store', async () => {
  let clock = 0;
  const tight = new MemoryIdempotencyStore({ pendingTimeoutMs: 100, now: () => clock });
  const loose = new MemoryIdempotencyStore({ pendingTimeoutMs: 100_000, now: () => clock });
  await tight.begin('key');
  await loose.begin('key');

  clock = 500;
  assert.equal((await tight.begin('key')).conflict, undefined, 'tight window expired');
  assert.equal((await loose.begin('key')).conflict, true, 'loose window still live');
});

test('the default timeout is used when none is given', async () => {
  let clock = 0;
  const store = new MemoryIdempotencyStore({ now: () => clock });
  assert.equal(store.pendingTimeoutMs, DEFAULT_PENDING_CLAIM_TIMEOUT_MS);
  await store.begin('default-window');

  clock = DEFAULT_PENDING_CLAIM_TIMEOUT_MS;
  assert.equal((await store.begin('default-window')).conflict, true);
  clock = DEFAULT_PENDING_CLAIM_TIMEOUT_MS + 1;
  assert.equal((await store.begin('default-window')).conflict, undefined);
});

test('a pending record without a timestamp is treated as abandoned', async () => {
  const store = new MemoryIdempotencyStore({ now: () => 5_000 });
  // Shape written before claims carried a timestamp.
  store.records.set('legacy-claim', { pending: true });

  const claim = await store.begin('legacy-claim');
  assert.equal(claim.conflict, undefined);
  assert.equal(claim.replayed, false);
  assert.equal(store.records.get('legacy-claim').claimedAt, 5_000);
});

test('fail() still releases a claim immediately', async () => {
  const store = new MemoryIdempotencyStore({ now: () => 0 });
  await store.begin('released');
  await store.fail('released');

  assert.equal(store.records.has('released'), false);
  assert.equal((await store.begin('released')).conflict, undefined);
});
