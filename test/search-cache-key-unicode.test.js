/**
 * #686: `café` typed precomposed and `cafe` + a combining acute are one
 * question. Without Unicode normalisation they were two cache keys and two
 * token strings, so a caller's keyboard or URL encoder decided whether the
 * cache hit and whether the ranking matched. NFC is the boundary, and only
 * NFC: compatibility folding (NFKC) and diacritic stripping would both conflate
 * genuinely different queries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCacheKey, scoreResource } from '../src/catalog/search.js';

/** `café` as one precomposed code point (U+00E9). */
const COMPOSED = 'caf\u00e9';
/** `cafe` + a combining acute (U+0301) — the decomposed spelling. */
const DECOMPOSED = 'cafe\u0301';

test('#686: precomposed and decomposed queries share one cache key', () => {
  assert.notEqual(COMPOSED, DECOMPOSED, 'the fixtures really are different byte strings');
  assert.equal(
    searchCacheKey({ query: COMPOSED }),
    searchCacheKey({ query: DECOMPOSED }),
    'both spellings must land on the same cache entry',
  );
});

test('#686: normalisation composes with the existing key canonicalisation', () => {
  assert.equal(
    searchCacheKey({ query: `  ${DECOMPOSED.toUpperCase()}  `, limit: 5 }),
    searchCacheKey({ query: COMPOSED, limit: 5 }),
    'padding, case and spelling all normalise away together',
  );
  assert.equal(
    searchCacheKey({ query: DECOMPOSED, limit: 5 }),
    searchCacheKey({ query: COMPOSED, limit: 5 }),
  );
});

test('#686: NFC only — different queries stay different keys', () => {
  // Stripping diacritics would wrongly collapse these.
  assert.notEqual(
    searchCacheKey({ query: COMPOSED }),
    searchCacheKey({ query: 'cafe' }),
    'café and cafe are different searches',
  );
  // NFKC would wrongly fold the ligature.
  assert.notEqual(
    searchCacheKey({ query: '\ufb01le' }), // ﬁle
    searchCacheKey({ query: 'file' }),
    'compatibility folding is out of scope; only canonical composition applies',
  );
});

test('#686: composed and decomposed catalogue values score identically', () => {
  // No `last_seen_at`: scoreResource applies a recency decay from Date.now(),
  // so two calls that straddle a millisecond boundary return nearly equal —
  // but not strictly equal — floats. This test is about normalisation, not
  // decay, so the fixtures leave the time term out and the scores are exact.
  const composed = {
    serviceName: `Weather ${COMPOSED}`,
    description: 'precomposed café',
    tags: [COMPOSED],
  };
  const decomposed = {
    serviceName: `Weather ${DECOMPOSED}`,
    description: 'precomposed café',
    tags: [DECOMPOSED],
  };

  for (const query of [COMPOSED, DECOMPOSED]) {
    const composedScore = scoreResource(composed, query);
    const decomposedScore = scoreResource(decomposed, query);

    assert.ok(composedScore > 0, 'the fixture is actually found');
    assert.equal(
      decomposedScore,
      composedScore,
      `spelling of the query (${JSON.stringify(query)}) and of the indexed fields must not change the score`,
    );
  }
});

test('#686: an unnormalised tag still matches an exact tag query', () => {
  // Before the fix, only the spelling that matched byte-for-byte earned the
  // exact-tag weight; the other fell through to the substring weight or zero.
  const resource = {
    serviceName: 'tag holder',
    tags: [DECOMPOSED],
  };
  assert.equal(scoreResource(resource, COMPOSED), scoreResource(resource, DECOMPOSED));
  assert.equal(scoreResource(resource, COMPOSED), 8, 'exact tag weight, not substring');
});
