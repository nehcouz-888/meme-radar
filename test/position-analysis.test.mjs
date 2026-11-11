/**
 * Tests for Position Analysis (Audit Fix #6)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTransaction,
  analyzePositionSize,
  detectPositionAnomalies,
  formatAnomalies,
  wouldHaveUsedPositionValueAsTrade
} from '../src/modules/position-analysis.mjs';

test('analyzeTransaction - 正常case有成交额和总资产', () => {
  const event = {
    tradeUsd: 5000,
    positionValueUsd: 5200,
    totalAssetsUsd: 100000,
    wallet: 'WALLET_A',
    token: 'TOKEN_X'
  };
  
  const result = analyzeTransaction(event);
  
  assert.equal(result.tradeUsd, 5000);
  assert.equal(result.positionValueUsd, 5200);
  assert.equal(result.totalAssetsUsd, 100000);
  assert.equal(result.isNewPosition, true);  // 5%
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.positionRatio, 0.05);
  assert.equal(result.qualifies5Percent, true);
});

test('analyzePositionSize - 无成交额 → 无法判定', () => {
  const tx = {
    tradeUsd: null,
    positionValueUsd: 10000,
    totalAssetsUsd: 50000
  };
  
  const result = analyzePositionSize(tx);
  
  assert.equal(result.isNewPosition, false);
  assert.equal(result.confidence, 'UNKNOWN');
  assert.equal(result.cannotDetermine, true);
  assert.match(result.reason, /无成交额/);
  assert.match(result.note, /仅有持仓市值/);
});

test('analyzePositionSize - 成交额>总资产 异常', () => {
  const tx = {
    tradeUsd: 120000,
    positionValueUsd: 120000,
    totalAssetsUsd: 100000
  };
  
  const result = analyzePositionSize(tx);
  
  assert.equal(result.isNewPosition, true);
  assert.equal(result.confidence, 'LOW');
  assert.equal(result.anomaly, 'TRADE_EXCEEDS_ASSETS');
  assert.match(result.anomalyNote, /超过总资产/);
  assert.match(result.warning, /数据异常/);
  assert.ok(result.positionRatio > 1.0);
});

test('analyzePositionSize - Fallback $3000', () => {
  const tx = {
    tradeUsd: 3500,
    positionValueUsd: null,
    totalAssetsUsd: null  // 无总资产
  };
  
  const result = analyzePositionSize(tx);
  
  assert.equal(result.isNewPosition, true);
  assert.equal(result.confidence, 'MEDIUM');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackThreshold, 3000);
  assert.equal(result.qualifies5Percent, 'ASSUMED');
  assert.match(result.note, /fallback/);
  assert.match(result.warning, /fallback heuristic/);
});

test('analyzePositionSize - 小于fallback且无总资产', () => {
  const tx = {
    tradeUsd: 2000,
    positionValueUsd: null,
    totalAssetsUsd: null
  };
  
  const result = analyzePositionSize(tx);
  
  assert.equal(result.isNewPosition, false);
  assert.equal(result.confidence, 'LOW');
  assert.match(result.reason, /不足\$3000/);
});

test('detectPositionAnomalies - 持仓超过总资产', () => {
  const tx = {
    tradeUsd: 95000,  // Recent trade
    positionValueUsd: 105000,  // Position slightly exceeds assets (price moved up)
    totalAssetsUsd: 100000
  };
  
  const anomalies = detectPositionAnomalies(tx);
  
  // Should detect position exceeds assets
  assert.ok(anomalies.positionExceedsAssets);
  assert.ok(anomalies.positionExceedsAssets.detected);
  assert.ok(anomalies.positionExceedsAssets.ratio > 1.0);
  assert.match(anomalies.positionExceedsAssets.message, /超过总资产/);
});

test('detectPositionAnomalies - 缺成交额', () => {
  const tx = {
    tradeUsd: null,
    positionValueUsd: 10000,
    totalAssetsUsd: 50000
  };
  
  const anomalies = detectPositionAnomalies(tx);
  
  assert.ok(anomalies.missingTradeAmount);
  assert.ok(anomalies.missingTradeAmount.detected);
  assert.equal(anomalies.missingTradeAmount.severity, 'LOW');
  assert.match(anomalies.missingTradeAmount.message, /无实际成交额/);
});

test('detectPositionAnomalies - 成交与持仓差异大', () => {
  const tx = {
    tradeUsd: 5000,
    positionValueUsd: 15000,  // 3倍差异
    totalAssetsUsd: 100000
  };
  
  const anomalies = detectPositionAnomalies(tx);
  
  assert.ok(anomalies.tradePositionMismatch);
  assert.ok(anomalies.tradePositionMismatch.detected);
  assert.equal(anomalies.tradePositionMismatch.severity, 'INFO');
  assert.ok(parseFloat(anomalies.tradePositionMismatch.diffPercent) > 50);
});

test('formatAnomalies - 格式化显示', () => {
  const anomalies = [
    {
      type: 'POSITION_EXCEEDS_ASSETS',
      severity: 'HIGH',
      message: '持仓超资产',
      recommendation: '标记异常'
    }
  ];
  
  const formatted = formatAnomalies(anomalies);
  
  assert.equal(formatted.hasAnomalies, true);
  assert.equal(formatted.count, 1);
  assert.equal(formatted.highSeverityCount, 1);
  assert.match(formatted.displayText, /数据异常检测/);
  assert.match(formatted.displayText, /持仓超资产/);
});

test('wouldHaveUsedPositionValueAsTrade - 检测旧逻辑bug', () => {
  const event = {
    tradeUsd: null,  // 无成交额
    usdValue: 50000  // 有持仓市值
  };
  
  const result = wouldHaveUsedPositionValueAsTrade(event);
  
  assert.equal(result.wouldHaveUsed, true);
  assert.equal(result.wrongValue, 50000);
  assert.match(result.warning, /旧逻辑会错误使用持仓市值/);
});

// Offline sample: MASK anomaly
test('MASK regression - positionValue 102.8% of assets', () => {
  const maskEvent = {
    eventId: 'mask-trader-a',
    wallet: 'TRADER_A',
    token: 'MASK',
    tradeUsd: null,  // ⚠️ 无成交额
    usdValue: 399021,  // positionValue
    totalValueUsd: 388084  // assets
  };
  
  const result = analyzeTransaction(maskEvent);
  
  // 检测到anomaly
  assert.ok(result.hasAnomalies);
  
  // 找到持仓超资产的anomaly
  assert.ok(result.anomalies.positionExceedsAssets);
  assert.ok(result.anomalies.positionExceedsAssets.detected);
  assert.ok(result.anomalies.positionExceedsAssets.ratio > 1.0);
  assert.match(result.anomalies.positionExceedsAssets.positionPercent, /102\./);
  
  // 找到缺成交额的anomaly
  assert.ok(result.anomalies.missingTradeAmount);
  assert.ok(result.anomalies.missingTradeAmount.detected);
  assert.match(result.anomalies.missingTradeAmount.impact, /无法确认买入规模/);
  
  // ❌ 不能判定为新仓（因为无成交额）
  assert.equal(result.isNewPosition, false);
  assert.equal(result.cannotDetermine, true);
  
  // ⚠️ 不应该指控钱包造假  
  assert.doesNotMatch(
    JSON.stringify(result.anomalies),
    /造假|fraud|manipulation/i
  );
});

test('MASK regression - 旧逻辑会误用positionValue', () => {
  const maskEvent = {
    tradeUsd: null,
    usdValue: 399021
  };
  
  const legacyCheck = wouldHaveUsedPositionValueAsTrade(maskEvent);
  
  assert.equal(legacyCheck.wouldHaveUsed, true);
  assert.equal(legacyCheck.wrongValue, 399021);
  
  // 旧逻辑: tradeAmount = tradeUsd || usdValue (WRONG!)
  // 会错误认为成交了 $399,021
});

test('正确case - 有成交额且合理', () => {
  const event = {
    tradeUsd: 10000,
    positionValueUsd: 10500,  // 价格涨了点
    totalAssetsUsd: 200000
  };
  
  const result = analyzeTransaction(event);
  
  assert.equal(result.isNewPosition, true);
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.qualifies5Percent, true);
  assert.ok(!result.hasAnomalies || result.anomalies.length === 0);
  
  const ratio = result.positionRatio;
  assert.ok(ratio >= 0.05);  // 10000/200000 = 5%
  assert.ok(ratio < 0.10);
});
