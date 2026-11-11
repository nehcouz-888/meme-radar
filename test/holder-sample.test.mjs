/**
 * Tests for Holder Sample Completeness (Audit Fix #2)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHolderSample,
  determineTokenStatus,
  scoreSmartMoneyWithCompleteness,
  mergeHolderSources,
  detectContradictorySamples
} from '../src/modules/holder-sample.mjs';

test('createHolderSample - 完整样本', () => {
  const wallets = [
    { address: 'A', tags: ['smart_degen'] },
    { address: 'B', tags: ['smart_degen'] }
  ];
  
  const sample = createHolderSample(wallets, {
    totalHolderCount: 2,
    source: 'fomo'
  });
  
  assert.equal(sample.sampleComplete, true);
  assert.equal(sample.sampledCount, 2);
  assert.match(sample.coverage, /完整/);
});

test('createHolderSample - 不完整样本', () => {
  const wallets = [
    { address: 'A', tags: ['smart_degen'] }
  ];
  
  const sample = createHolderSample(wallets, {
    totalHolderCount: 50,
    source: 'fomo'
  });
  
  assert.equal(sample.sampleComplete, false);
  assert.equal(sample.sampledCount, 1);
  assert.match(sample.coverage, /部分样本/);
  assert.match(sample.coverage, /1\/50/);
});

test('createHolderSample - 100个认定为足够代表性', () => {
  const wallets = Array.from({ length: 100 }, (_, i) => ({
    address: `WALLET_${i}`,
    tags: i < 10 ? ['smart_degen'] : []
  }));
  
  const sample = createHolderSample(wallets, {
    totalHolderCount: null,  // 未知总数
    source: 'fomo'
  });
  
  assert.equal(sample.sampleComplete, true);
  assert.equal(sample.sampledCount, 100);
  assert.match(sample.coverage, /足够代表性/);
});

test('determineTokenStatus - 三种状态', () => {
  const token = { rank: 15 };
  
  // 完整样本
  const completeSample = {
    sampleComplete: true,
    sampledCount: 50
  };
  
  const status1 = determineTokenStatus(token, completeSample);
  assert.equal(status1.onTopBoard, true);
  assert.equal(status1.currentConfirmed, true);
  assert.equal(status1.unknown, false);
  
  // 不完整样本
  const incompleteSample = {
    sampleComplete: false,
    sampledCount: 10
  };
  
  const status2 = determineTokenStatus(token, incompleteSample);
  assert.equal(status2.onTopBoard, true);
  assert.equal(status2.currentConfirmed, false);
  assert.equal(status2.unknown, true);
});

test('scoreSmartMoneyWithCompleteness - 完整样本0个', () => {
  const token = {};
  const sample = {
    wallets: [],  // 0个聪明钱
    sampleComplete: true,
    coverage: '当前确认完整',
    sampledCount: 0
  };
  
  const result = scoreSmartMoneyWithCompleteness(token, sample, 36);
  
  assert.equal(result.smartWallets, 0);
  assert.equal(result.score, 0);  // ✅ 不应该使用历史36个
  assert.equal(result.confidence, 'HIGH');
  assert.match(result.note, /0个聪明钱仍持仓/);
  assert.match(result.note, /历史36个已全部退出/);
});

test('scoreSmartMoneyWithCompleteness - 不完整样本降权使用历史', () => {
  const token = {};
  const sample = {
    wallets: [],
    sampleComplete: false,
    coverage: '部分样本10个-未知总数',
    sampledCount: 10
  };
  
  const result = scoreSmartMoneyWithCompleteness(token, sample, 36);
  
  assert.equal(result.smartWallets, 0);
  assert.equal(result.score, 36 * 0.3);  // 降权30%
  assert.equal(result.confidence, 'LOW');
  assert.match(result.note, /样本不完整/);
  assert.match(result.note, /降权使用历史/);
  assert.equal(result.aggregateFallback, true);
});

test('scoreSmartMoneyWithCompleteness - 完整样本3个', () => {
  const wallets = [
    { address: 'A', tags: ['smart_degen'] },
    { address: 'B', tags: ['smart_degen'] },
    { address: 'C', tags: ['smart_degen'] }
  ];
  
  const token = {};
  const sample = {
    wallets,
    sampleComplete: true,
    coverage: '当前确认完整',
    sampledCount: 3
  };
  
  const result = scoreSmartMoneyWithCompleteness(token, sample, 0);
  
  assert.equal(result.smartWallets, 3);
  assert.equal(result.score, 20);  // ≥3 → +20pts
  assert.equal(result.confidence, 'HIGH');
  assert.match(result.note, /3个聪明钱仍持仓/);
});

// Offline sample regression test: holder_conflict
test('Offline sample - holder_conflict 不混淆榜单与实时', () => {
  const leaderboardHolders = ['SMART_A', 'SMART_B'];
  const liveSample = {
    wallets: [
      { address: 'SMART_A', tags: ['smart_degen'] }
    ],
    sampleComplete: false  // ⚠️ 不完整
  };
  
  const merged = mergeHolderSources(
    leaderboardHolders.map(a => ({ address: a })),
    liveSample
  );
  
  // 并集是2，但不能当作live confirmed
  assert.equal(merged.unionCount, 2);
  assert.equal(merged.confirmedCount, null);  // ⚠️ 样本不完整，不能确认
  assert.match(merged.warning, /未完整样本/);
});

test('detectContradictorySamples - 检测榜单与实时不一致', () => {
  const leaderboardHolders = [
    { address: 'SMART_A' },
    { address: 'SMART_B' }
  ];
  
  const liveSample = {
    wallets: [
      { address: 'SMART_A' }
      // SMART_B 不在实时样本中
    ],
    sampleComplete: true
  };
  
  const result = detectContradictorySamples(leaderboardHolders, liveSample);
  
  assert.equal(result.contradictory, true);
  assert.deepEqual(result.onlyInLeaderboard, ['SMART_B']);
  assert.equal(result.recommendation, 'Use live confirmed count only');
});

test('detectContradictorySamples - 样本不完整无法判定矛盾', () => {
  const leaderboardHolders = [
    { address: 'SMART_A' },
    { address: 'SMART_B' }
  ];
  
  const liveSample = {
    wallets: [{ address: 'SMART_A' }],
    sampleComplete: false  // 不完整
  };
  
  const result = detectContradictorySamples(leaderboardHolders, liveSample);
  
  assert.equal(result.contradictory, false);
  assert.match(result.reason, /incomplete/i);
});

// AURACAT regression test
test('AURACAT regression - aggregate=36, live=0 应该使用live', () => {
  const auracatToken = {
    chain: 'sol',
    address: 'AURACATxHyMZZhQMWU35n3cAZYkKzYxoKFztHibPPxk',
    symbol: 'AURACAT'
  };
  
  // 聚合显示36个，但实时持仓0个（样本完整）
  const auracatSample = {
    wallets: [],  // 0个
    sampleComplete: true,
    coverage: '当前确认完整',
    sampledCount: 0
  };
  
  const result = scoreSmartMoneyWithCompleteness(
    auracatToken,
    auracatSample,
    36  // aggregateSmart = 36
  );
  
  // ✅ 应该使用live的0，不是aggregate的36
  assert.equal(result.smartWallets, 0);
  assert.equal(result.score, 0);
  assert.equal(result.confidence, 'HIGH');
  assert.match(result.note, /0个聪明钱仍持仓/);
  assert.match(result.note, /历史36个已全部退出/);
  
  // 旧逻辑会给 +20 分（因为36≥3），新逻辑给0分
  const oldScore = 20;  // aggregate 36 → +20
  assert.ok(result.score < oldScore, 'New logic should score lower than old logic');
});
