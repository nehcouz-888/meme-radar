/**
 * Tests for Market Cap Tiering (Audit Fix #1 - Remove <$100k hard limit)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKET_CAP_TIERS,
  categorizeByMarketCap,
  marketCapScoreModifier,
  checkTierEvidenceRequirements,
  wouldHaveBeenRejectedUnderOldRules
} from '../src/modules/market-cap-tiers.mjs';

test('MARKET_CAP_TIERS - 常量定义', () => {
  assert.ok(MARKET_CAP_TIERS.EMBRYONIC);
  assert.ok(MARKET_CAP_TIERS.EARLY);
  assert.ok(MARKET_CAP_TIERS.GROWTH);
  assert.ok(MARKET_CAP_TIERS.ESTABLISHED);
  assert.ok(MARKET_CAP_TIERS.LARGE_CAP);
  
  // Check min evidence levels
  assert.equal(MARKET_CAP_TIERS.EMBRYONIC.minEvidence, 'MEDIUM');
  assert.equal(MARKET_CAP_TIERS.ESTABLISHED.minEvidence, 'STRICT');
});

test('categorizeByMarketCap - EMBRYONIC <$50k', () => {
  const result = categorizeByMarketCap(30000);
  
  assert.equal(result.tier, 'EMBRYONIC');
  assert.equal(result.minEvidence, 'MEDIUM');
  assert.match(result.marketCapBand, /0-5万/);
});

test('categorizeByMarketCap - EARLY $50k-200k', () => {
  const result = categorizeByMarketCap(150000);
  
  assert.equal(result.tier, 'EARLY');
  assert.equal(result.minEvidence, 'MEDIUM');
  assert.match(result.marketCapBand, /5万-20万/);
});

test('categorizeByMarketCap - GROWTH $200k-1M', () => {
  const result = categorizeByMarketCap(500000);
  
  assert.equal(result.tier, 'GROWTH');
  assert.equal(result.minEvidence, 'HIGH');
  assert.match(result.marketCapBand, /20万-100万/);
  assert.match(result.note, /更高证据/);
});

test('categorizeByMarketCap - ESTABLISHED $1M-20M', () => {
  const result = categorizeByMarketCap(5000000);
  
  assert.equal(result.tier, 'ESTABLISHED');
  assert.equal(result.minEvidence, 'STRICT');
  assert.equal(result.requireCrossValidation, true);
  assert.match(result.marketCapBand, /100万-2000万/);
});

test('categorizeByMarketCap - LARGE_CAP >$20M', () => {
  const result = categorizeByMarketCap(50000000);
  
  assert.equal(result.tier, 'LARGE_CAP');
  assert.equal(result.minEvidence, 'STRICT');
  assert.equal(result.requireCrossValidation, true);
  assert.equal(result.requireMultiSource, true);
});

test('marketCapScoreModifier - 分层调整系数', () => {
  assert.equal(marketCapScoreModifier('EMBRYONIC'), 1.0);
  assert.equal(marketCapScoreModifier('EARLY'), 1.0);
  assert.equal(marketCapScoreModifier('GROWTH'), 0.85);
  assert.equal(marketCapScoreModifier('ESTABLISHED'), 0.7);
  assert.equal(marketCapScoreModifier('LARGE_CAP'), 0.5);
});

test('marketCapScoreModifier - 应用到评分', () => {
  const rawScore = 80;
  
  const embryonic = rawScore * marketCapScoreModifier('EMBRYONIC');
  const growth = rawScore * marketCapScoreModifier('GROWTH');
  const large = rawScore * marketCapScoreModifier('LARGE_CAP');
  
  assert.equal(embryonic, 80);  // 1.0 * 80
  assert.equal(growth, 68);     // 0.85 * 80
  assert.equal(large, 40);      // 0.5 * 80
  
  // 高市值需要更强证据才能获得同等分数
  assert.ok(embryonic > growth);
  assert.ok(growth > large);
});

test('checkTierEvidenceRequirements - ESTABLISHED需要跨源验证', () => {
  const token = {
    marketCap: 5000000,
    crossValidated: false  // ⚠️ 未跨源验证
  };
  
  const tierInfo = categorizeByMarketCap(token.marketCap);
  const checks = checkTierEvidenceRequirements(token, tierInfo);
  
  assert.equal(checks.qualified, false);
  assert.ok(checks.warnings.some(w => w.includes('跨源验证')));
  assert.ok(checks.recommendations.some(r => r.includes('2个独立数据源')));
});

test('checkTierEvidenceRequirements - LARGE_CAP需要多源', () => {
  const token = {
    marketCap: 30000000,
    crossValidated: true,
    sourceCount: 1  // ⚠️ 只有1个来源
  };
  
  const tierInfo = categorizeByMarketCap(token.marketCap);
  const checks = checkTierEvidenceRequirements(token, tierInfo);
  
  assert.equal(checks.qualified, false);
  assert.ok(checks.warnings.some(w => w.includes('多源确认')));
});

test('checkTierEvidenceRequirements - GROWTH通过', () => {
  const token = {
    marketCap: 500000,
    evidenceConfidence: 'HIGH',
    sourceCount: 1
  };
  
  const tierInfo = categorizeByMarketCap(token.marketCap);
  const checks = checkTierEvidenceRequirements(token, tierInfo);
  
  assert.equal(checks.qualified, true);
  assert.equal(checks.warnings.length, 0);
});

test('wouldHaveBeenRejectedUnderOldRules - >$200k被拒', () => {
  assert.equal(wouldHaveBeenRejectedUnderOldRules(100000), false);
  assert.equal(wouldHaveBeenRejectedUnderOldRules(200000), false);
  assert.equal(wouldHaveBeenRejectedUnderOldRules(250000), true);
  assert.equal(wouldHaveBeenRejectedUnderOldRules(1000000), true);
});

// Regression test: 旧规则会拒绝的币现在可以通过
test('Regression - 减贫脱贫案例', () => {
  // MC约$3400, liq约$7600
  // 旧规则会因MC<10k被拒
  const token = {
    marketCap: 3400,
    liquidity: 7600
  };
  
  const tierInfo = categorizeByMarketCap(token.marketCap);
  
  // 现在归类为EMBRYONIC，不硬性拒绝
  assert.equal(tierInfo.tier, 'EMBRYONIC');
  assert.equal(tierInfo.minEvidence, 'MEDIUM');
  
  // 流动性满足$5k要求
  assert.ok(token.liquidity >= 5000);
  
  // ✅ 不再因市值低被硬性排除
});

test('Regression - 高市值币不因市值被排除', () => {
  const token = {
    marketCap: 15000000,  // $15M
    evidenceConfidence: 'HIGH',
    crossValidated: true,
    sourceCount: 2
  };
  
  const tierInfo = categorizeByMarketCap(token.marketCap);
  
  // 归类为ESTABLISHED
  assert.equal(tierInfo.tier, 'ESTABLISHED');
  
  // 检查证据要求
  const checks = checkTierEvidenceRequirements(token, tierInfo);
  assert.equal(checks.qualified, true);
  
  // ✅ 满足STRICT要求可以通过，不因市值高被硬排除
});

test('边界测试 - 各分层边界', () => {
  // 边界值应该归入较高分层
  assert.equal(categorizeByMarketCap(49999).tier, 'EMBRYONIC');
  assert.equal(categorizeByMarketCap(50000).tier, 'EARLY');
  assert.equal(categorizeByMarketCap(199999).tier, 'EARLY');
  assert.equal(categorizeByMarketCap(200000).tier, 'GROWTH');
  assert.equal(categorizeByMarketCap(999999).tier, 'GROWTH');
  assert.equal(categorizeByMarketCap(1000000).tier, 'ESTABLISHED');
  assert.equal(categorizeByMarketCap(19999999).tier, 'ESTABLISHED');
  assert.equal(categorizeByMarketCap(20000000).tier, 'LARGE_CAP');
});

test('政策变更验证 - 取消硬限制', () => {
  // 旧政策: discoveryMaxMarketCap = 200_000 (硬拒绝)
  // 新政策: 分层参考，不硬拒绝
  
  const testCases = [
    { mc: 50_000, shouldPassOld: true, shouldPassNew: true },
    { mc: 200_000, shouldPassOld: true, shouldPassNew: true },
    { mc: 300_000, shouldPassOld: false, shouldPassNew: true },  // ⬅ 变化
    { mc: 1_000_000, shouldPassOld: false, shouldPassNew: true },  // ⬅ 变化
    { mc: 10_000_000, shouldPassOld: false, shouldPassNew: true }  // ⬅ 变化
  ];
  
  for (const tc of testCases) {
    const tierInfo = categorizeByMarketCap(tc.mc);
    const wasRejected = wouldHaveBeenRejectedUnderOldRules(tc.mc);
    
    assert.equal(!wasRejected, tc.shouldPassOld, 
      `MC=${tc.mc} old policy check failed`);
    
    // 新政策: 所有市值都可以进入评估（只要满足证据要求）
    assert.ok(tierInfo.tier, `MC=${tc.mc} should have tier`);
  }
});
