import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { loadRemoteKeys } from '../src/facilitator.js';

const URL_UNDER_TEST = 'http://127.0.0.1:9/key-source';

async function withFetch(keys, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: name => (name === 'content-type' ? 'application/json' : null) },
    json: async () => ({ keys }),
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('loadRemoteKeys accepts a valid bare-string seed', async () => {
  const secret = Keypair.random().secret();
  await withFetch([secret], async () => {
    assert.deepEqual(await loadRemoteKeys(URL_UNDER_TEST, 2000), [secret]);
  });
});

test('loadRemoteKeys accepts a valid object secret entry', async () => {
  const secret = Keypair.random().secret();
  await withFetch([{ secret, kid: 'key-one' }], async () => {
    assert.deepEqual(await loadRemoteKeys(URL_UNDER_TEST, 2000), [{ secret, kid: 'key-one' }]);
  });
});

test('loadRemoteKeys identifies each bad entry by array index', async t => {
  const cases = [
    [null, /keys\[0\].*string|keys\[0\].*secret/],
    [42, /keys\[0\].*string|keys\[0\].*secret/],
    [{}, /keys\[0\]\.secret/],
    [{ secret: 'SNOT-A-VALID-SEED' }, /keys\[0\]\.secret/],
  ];

  for (const [entry, pattern] of cases) {
    await t.test(
      typeof entry === 'object' && entry !== null ? JSON.stringify(entry) : String(entry),
      async () => {
        await withFetch([entry], async () => {
          await assert.rejects(
            () => loadRemoteKeys(URL_UNDER_TEST, 2000),
            err => {
              assert.match(err.message, pattern);
              if (typeof entry === 'string') assert.equal(err.message.includes(entry), false);
              if (entry?.secret) assert.equal(err.message.includes(entry.secret), false);
              return true;
            },
          );
        });
      },
    );
  }
});

test('a bad later entry reports its exact index and never reveals its value', async () => {
  const first = Keypair.random().secret();
  const second = Keypair.random().secret();
  const bad = 'SNOT-A-VALID-SEED';
  await withFetch([first, { secret: second }, bad], async () => {
    await assert.rejects(
      () => loadRemoteKeys(URL_UNDER_TEST, 2000),
      err => {
        assert.match(err.message, /keys\[2\]/);
        assert.equal(err.message.includes(bad), false);
        return true;
      },
    );
  });
});
