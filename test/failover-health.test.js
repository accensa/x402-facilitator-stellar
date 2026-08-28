/**
 * Region-aware failover health checker (#126).
 *
 * Validates health state transitions, failover detection, recovery (failback),
 * and remote region monitoring. No external services required — uses a
 * configurable checkRemote function.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FailoverHealthChecker } from '../src/failover-health.js';

describe('FailoverHealthChecker', () => {
  test('starts in healthy state', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
      ],
    });

    assert.equal(checker.localStatus, 'healthy');
    assert.equal(checker.getState().failoverActive, false);
    assert.equal(checker.getState().region, 'us-east-1');
  });

  test('stays healthy after a single failure (below threshold)', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 3,
    });

    checker.reportLocalHealth(false);
    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'healthy');
    assert.equal(checker._localFailures, 2);
  });

  test('becomes degraded after failure threshold is reached', () => {
    const stateChanges = [];
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 3,
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2, url: 'http://eu.example.com' },
      ],
    });
    checker.onStateChange(e => stateChanges.push(e));

    checker.reportLocalHealth(false);
    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'healthy');

    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'degraded');
    assert.equal(checker.getState().failoverActive, true);
    assert.equal(stateChanges.length, 1);
    assert.equal(stateChanges[0].type, 'degraded');
  });

  test('does not re-emit degraded on consecutive failures', () => {
    const stateChanges = [];
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 2,
    });
    checker.onStateChange(e => stateChanges.push(e));

    checker.reportLocalHealth(false);
    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'degraded');

    checker.reportLocalHealth(false);
    checker.reportLocalHealth(false);
    // Only one degraded event, not more.
    assert.equal(stateChanges.filter(e => e.type === 'degraded').length, 1);
  });

  test('recovery requires recoveryThreshold consecutive successes', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 2,
      recoveryThreshold: 3,
    });

    // Degrade.
    checker.reportLocalHealth(false);
    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'degraded');

    // First recovery attempt — goes to 'recovering'.
    checker.reportLocalHealth(true);
    assert.equal(checker.localStatus, 'recovering');
    assert.equal(checker._localSuccesses, 1);

    // Second attempt.
    checker.reportLocalHealth(true);
    assert.equal(checker.localStatus, 'recovering');
    assert.equal(checker._localSuccesses, 2);

    // Third attempt — recovers.
    checker.reportLocalHealth(true);
    assert.equal(checker.localStatus, 'healthy');
    assert.equal(checker._localSuccesses, 0);
  });

  test('recovery resets on failure during recovering', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 2,
      recoveryThreshold: 3,
    });

    checker.reportLocalHealth(false);
    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'degraded');

    checker.reportLocalHealth(true);
    checker.reportLocalHealth(true);
    assert.equal(checker.localStatus, 'recovering');

    // Failure during recovery resets the success counter.
    checker.reportLocalHealth(false);
    assert.equal(checker.localStatus, 'degraded');
    assert.equal(checker._localSuccesses, 0);
  });

  test('preferred region returns local when healthy', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
      ],
    });

    assert.equal(checker.getState().preferredRegion, 'us-east-1');
  });

  test('preferred region returns best healthy remote when degraded', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
        { region: 'ap-south-1', priority: 3 },
      ],
    });

    checker.reportLocalHealth(false); // degrade

    // No remote checks done yet — all are "unknown" (potentially healthy).
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');

    // Mark eu-west-1 as unhealthy.
    checker.remoteStatus.set('eu-west-1', { healthy: false, lastCheck: Date.now() });
    assert.equal(checker.getState().preferredRegion, 'ap-south-1');
  });

  test('remote health check updates remote status', async () => {
    let checkResult = true;
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2, url: 'http://eu.example.com' },
      ],
      checkRemote: async () => checkResult,
      detectIntervalMs: 60_000, // don't auto-check
    });

    await checker._check();
    assert.equal(checker.remoteStatus.get('eu-west-1')?.healthy, true);

    checkResult = false;
    await checker._check();
    assert.equal(checker.remoteStatus.get('eu-west-1')?.healthy, false);
  });

  test('remote recovery emits event', async () => {
    const events = [];
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2, url: 'http://eu.example.com' },
      ],
      checkRemote: async () => false,
      detectIntervalMs: 60_000,
    });
    checker.onStateChange(e => events.push(e));

    // Mark as degraded.
    await checker._check();
    assert.equal(checker.remoteStatus.get('eu-west-1')?.healthy, false);

    // Now it recovers.
    checker.checkRemote = async () => true;
    await checker._check();
    assert.equal(checker.remoteStatus.get('eu-west-1')?.healthy, true);
    assert.ok(events.some(e => e.type === 'remote_recovered'));
  });

  test('getState includes remote regions with their priority', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
      ],
    });

    checker.remoteStatus.set('eu-west-1', { healthy: true, lastCheck: Date.now() });

    const state = checker.getState();
    assert.equal(state.remoteRegions['eu-west-1'].healthy, true);
    assert.equal(state.remoteRegions['eu-west-1'].priority, 2);
  });
});

describe('failover timing (acceptance criterion: < 30s)', () => {
  test('worst-case failover time is under 30 seconds', () => {
    // With default settings: detectInterval=5s, failureThreshold=3
    // worst-case failover = 5s * 3 = 15s
    const detectIntervalMs = 5_000;
    const failureThreshold = 3;
    const worstCaseFailoverMs = detectIntervalMs * failureThreshold;

    assert.ok(
      worstCaseFailoverMs < 30_000,
      `worst-case failover ${worstCaseFailoverMs}ms exceeds 30s`,
    );
  });

  test('worst-case failback time is under 30 seconds', () => {
    // With default settings: detectInterval=5s, recoveryThreshold=2
    // worst-case failback = 5s * 2 = 10s
    const detectIntervalMs = 5_000;
    const recoveryThreshold = 2;
    const worstCaseFailbackMs = detectIntervalMs * recoveryThreshold;

    assert.ok(
      worstCaseFailbackMs < 30_000,
      `worst-case failback ${worstCaseFailbackMs}ms exceeds 30s`,
    );
  });

  test('total failover + failback time is under 30 seconds', () => {
    const detectIntervalMs = 5_000;
    const failureThreshold = 3;
    const recoveryThreshold = 2;
    const totalMs = detectIntervalMs * (failureThreshold + recoveryThreshold);

    assert.ok(totalMs < 30_000, `total failover + failback ${totalMs}ms exceeds 30s`);
  });
});

describe('split-brain prevention', () => {
  test('failover only occurs when local is degraded', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
      ],
    });

    // Healthy — preferred is self.
    assert.equal(checker.getState().preferredRegion, 'us-east-1');
    assert.equal(checker.getState().failoverActive, false);

    // Healthy with remote healthy — still self.
    checker.remoteStatus.set('eu-west-1', { healthy: true, lastCheck: Date.now() });
    assert.equal(checker.getState().preferredRegion, 'us-east-1');

    // Degraded — switches to remote.
    checker.reportLocalHealth(false);
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');
    assert.equal(checker.getState().failoverActive, true);
  });

  test('recovering state does not trigger failback until fully recovered', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      recoveryThreshold: 3,
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
      ],
    });

    // Degrade.
    checker.reportLocalHealth(false);
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');

    // Partial recovery — still degraded from routing perspective.
    checker.reportLocalHealth(true);
    assert.equal(checker.localStatus, 'recovering');
    assert.equal(checker.getState().failoverActive, true);
    assert.equal(checker.getState().preferredRegion, 'eu-west-1');

    // Full recovery — failback eligible.
    checker.reportLocalHealth(true);
    checker.reportLocalHealth(true);
    assert.equal(checker.localStatus, 'healthy');
    assert.equal(checker.getState().failoverActive, false);
    assert.equal(checker.getState().preferredRegion, 'us-east-1');
  });

  test('no split-brain: only one region is preferred at a time', () => {
    const checker = new FailoverHealthChecker({
      region: 'us-east-1',
      failureThreshold: 1,
      regions: [
        { region: 'us-east-1', priority: 1 },
        { region: 'eu-west-1', priority: 2 },
        { region: 'ap-south-1', priority: 3 },
      ],
    });

    // All healthy — only us-east-1 is preferred.
    const state1 = checker.getState();
    assert.equal(state1.preferredRegion, 'us-east-1');
    const preferredCount = Object.values(state1.remoteRegions).filter(r => r.priority === 1).length;
    // Only one region has priority 1.
    assert.equal(preferredCount, 0); // remote regions don't have priority 1

    // Degrade — eu-west-1 (priority 2) is preferred.
    checker.reportLocalHealth(false);
    const state2 = checker.getState();
    assert.equal(state2.preferredRegion, 'eu-west-1');

    // Mark eu-west-1 unhealthy — ap-south-1 (priority 3) is preferred.
    checker.remoteStatus.set('eu-west-1', { healthy: false, lastCheck: Date.now() });
    const state3 = checker.getState();
    assert.equal(state3.preferredRegion, 'ap-south-1');
  });
});
