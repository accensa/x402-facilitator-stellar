/**
 * Trailing-slash URL joining and strict preferred-region selection (#759).
 *
 * Two regressions from the original behavior, both silently breaking failover:
 *   - defaultCheckRemote built `${url}/healthz`; a configured remote URL with
 *     a trailing slash produced `//healthz` requests that strict routers 404,
 *     so every remote looked dead and failover never fired.
 *   - _getPreferredRegion treated an unverified remote as "potentially
 *     healthy" (status === undefined), so a completely dead remote was routed
 *     to when the local region was merely degraded.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FailoverHealthChecker } from '../src/failover-health.js';

/**
 * Replaces globalThis.fetch with a recorder; returns the requested URLs and a
 * restore function. The real defaultCheckRemote is exercised — only the
 * transport is stubbed.
 */
function stubFetch() {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    requested.push(String(url));
    return { ok: true };
  };
  return {
    requested,
    restore() {
      globalThis.fetch = original;
    },
  };
}

describe('defaultCheckRemote URL joining (#759)', () => {
  test('a trailing slash is trimmed before appending /healthz', async () => {
    const stub = stubFetch();
    try {
      const checker = new FailoverHealthChecker({ region: 'us-east-1' });
      assert.equal(await checker.checkRemote('http://us-west.internal:8000/'), true);
      assert.deepEqual(stub.requested, ['http://us-west.internal:8000/healthz']);
    } finally {
      stub.restore();
    }
  });

  test('a URL without a trailing slash still gets exactly one /healthz', async () => {
    const stub = stubFetch();
    try {
      const checker = new FailoverHealthChecker({ region: 'us-east-1' });
      assert.equal(await checker.checkRemote('http://us-west.internal:8000'), true);
      assert.deepEqual(stub.requested, ['http://us-west.internal:8000/healthz']);
    } finally {
      stub.restore();
    }
  });

  test('multiple trailing slashes are all trimmed', async () => {
    const stub = stubFetch();
    try {
      const checker = new FailoverHealthChecker({ region: 'us-east-1' });
      assert.equal(await checker.checkRemote('http://us-west.internal:8000//'), true);
      assert.deepEqual(stub.requested, ['http://us-west.internal:8000/healthz']);
    } finally {
      stub.restore();
    }
  });

  test('an unreachable remote still reports false', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };
    try {
      const checker = new FailoverHealthChecker({ region: 'us-east-1' });
      assert.equal(await checker.checkRemote('http://us-west.internal:8000/'), false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('_getPreferredRegion requires affirmative remote health (#759)', () => {
  const REGIONS = [
    { region: 'us-east-1', priority: 1 },
    { region: 'eu-west-1', priority: 2, url: 'http://eu.example.com' },
    { region: 'ap-south-1', priority: 3, url: 'http://ap.example.com' },
  ];

  test('local is preferred while healthy, even with affirmatively healthy remotes', () => {
    const checker = new FailoverHealthChecker({ region: 'us-east-1', regions: REGIONS });
    checker.remoteStatus.set('eu-west-1', { healthy: true, lastCheck: Date.now() });
    assert.equal(checker.getState().preferredRegion, 'us-east-1');
  });

  test('a remote with no completed check is not preferred while local is degraded', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: REGIONS,
    });
    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'degraded');
    // Strict: an unverified remote must not win over the degraded local region.
    assert.equal(checker.getState().preferredRegion, 'us-east-1');
  });

  test('a remote reporting healthy: false is not preferred', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: REGIONS,
    });
    checker.reportLocalHealth(false);
    checker.remoteStatus.set('eu-west-1', { healthy: false, lastCheck: Date.now() });
    assert.equal(checker.getState().preferredRegion, 'us-east-1');
  });

  test('an affirmatively healthy remote is preferred while local is degraded', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: REGIONS,
    });
    checker.reportLocalHealth(false);
    checker.remoteStatus.set('eu-west-1', { healthy: true, lastCheck: Date.now() });
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');
  });

  test('the highest-priority affirmatively healthy remote wins the failover', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: REGIONS,
    });
    checker.reportLocalHealth(false);
    checker.remoteStatus.set('ap-south-1', { healthy: true, lastCheck: Date.now() });
    checker.remoteStatus.set('eu-west-1', { healthy: true, lastCheck: Date.now() });
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');
  });

  test('when the affirmatively healthy remote degrades, the local region takes the fallback', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: REGIONS,
    });
    checker.reportLocalHealth(false);
    checker.remoteStatus.set('eu-west-1', { healthy: true, lastCheck: Date.now() });
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');
    checker.remoteStatus.set('eu-west-1', { healthy: false, lastCheck: Date.now() });
    assert.equal(checker.getState().preferredRegion, 'us-east-1');
  });
});
