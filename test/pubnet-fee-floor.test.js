import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { resolveConfig, PUBNET } from '../src/config.js';

describe('Issue #650: pubnet fee ceiling calibration & floor guard', () => {
  const SECRET_1 = Keypair.random().secret();
  const SECRET_2 = Keypair.random().secret();

  const basePubnetEnv = {
    FACILITATOR_SECRET: SECRET_1,
    ENABLE_PUBNET: 'true',
    FACILITATOR_SECRET_PUBNET: SECRET_2,
    STELLAR_RPC_URL_PUBNET: 'https://pubnet.local',
  };

  test('resolveConfig defaults MAX_TX_FEE_STROOPS_PUBNET to derived default (50,000) when unset', () => {
    const config = resolveConfig(basePubnetEnv);
    assert.strictEqual(
      config.perNetwork[PUBNET].maxTransactionFeeStroops,
      50_000,
      'Unset pubnet ceiling must default to calibrated 50,000 stroops',
    );
  });

  test('resolveConfig rejects MAX_TX_FEE_STROOPS_PUBNET below documented floor (5,056 stroops)', () => {
    const belowFloorValues = ['100', '1000', '5000', '5055', '0', '-5000'];
    for (const val of belowFloorValues) {
      assert.throws(
        () =>
          resolveConfig({
            ...basePubnetEnv,
            MAX_TX_FEE_STROOPS_PUBNET: val,
          }),
        /MAX_TX_FEE_STROOPS_PUBNET must be a finite integer between 5056 and 10000000/,
        `Expected MAX_TX_FEE_STROOPS_PUBNET=${val} to be rejected below floor 5056`,
      );
    }
  });

  test('resolveConfig accepts documented floor boundary (5,056 stroops)', () => {
    const config = resolveConfig({
      ...basePubnetEnv,
      MAX_TX_FEE_STROOPS_PUBNET: '5056',
    });
    assert.strictEqual(
      config.perNetwork[PUBNET].maxTransactionFeeStroops,
      5056,
      'Documented floor 5056 must be accepted',
    );
  });

  test('resolveConfig accepts configured ceiling above the floor', () => {
    const config = resolveConfig({
      ...basePubnetEnv,
      MAX_TX_FEE_STROOPS_PUBNET: '75000',
    });
    assert.strictEqual(config.perNetwork[PUBNET].maxTransactionFeeStroops, 75_000);
  });

  test('daily budget divides by ceiling to express operator settlement capacity', () => {
    const configDefault = resolveConfig(basePubnetEnv);
    const dailyFeeSpd = configDefault.rateLimits.global.feeSpd; // 5,000,000 stroops
    assert.strictEqual(dailyFeeSpd, 5_000_000);

    const defaultCeiling = configDefault.perNetwork[PUBNET].maxTransactionFeeStroops;
    const worstCaseDailySettlements = Math.floor(dailyFeeSpd / defaultCeiling);
    assert.strictEqual(
      worstCaseDailySettlements,
      100,
      'Daily capacity at default ceiling must admit 100 settlements/day',
    );

    const floorCeiling = 5056;
    const floorDailySettlements = Math.floor(dailyFeeSpd / floorCeiling);
    assert.strictEqual(
      floorDailySettlements,
      988,
      'Daily capacity at measured floor must admit 988 settlements/day',
    );
  });
});
