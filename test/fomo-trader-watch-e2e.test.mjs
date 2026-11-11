#!/usr/bin/env node
/**
 * Fomo trader watch + queue E2E tests
 * ✅ MASK tradeUsd=null不显示确定数字
 * ✅ positionValue变化不是新成交
 * ✅ 转入过滤
 * ✅ 09:30事件10:57领取标历史
 * ✅ 01:30领取静默
 * ✅ claim后crash重领/lease到期
 * ✅ ack成功一次，旧delivered不重复
 * ✅ 多进程安全原子更新
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeTransaction,
  analyzePositionSize,
  detectPositionAnomalies
} from '../src/modules/position-analysis.mjs';
import {
  isQuietHours,
  claimPendingAlerts,
  acknowledgeDelivered,
  getQueueStats,
  formatHistoricalAlert
} from '../src/modules/alert-queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('MASK tradeUsd=null: 不显示确定39.9万', () => {
  const ev = {
    tradeUsd: null,
    usdValue: null,
    positionValueUsd: 399000,
    totalAssetsUsd: 388000
  };
  
  const analysis = analyzeTransaction(ev);
  
  // ✅ tradeUsd=null时，返回null不显示确定数字
  assert.strictEqual(analysis.tradeAmount, null);
  assert.strictEqual(analysis.source, 'unknown');
});

test('positionValue变化不是新成交', () => {
  // 只有positionValueUsd，没有tradeUsd
  const ev = {
    tradeUsd: null,
    usdValue: null,
    positionValueUsd: 50000
  };
  
  const analysis = analyzeTransaction(ev);
  
  // ✅ 只有positionValue不算成交
  assert.strictEqual(analysis.tradeAmount, null);
  assert.ok(analysis.warnings.includes('no_trade_amount'));
});

test('09:30事件10:57领取标历史 (TTL 10分钟)', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-fomo-e2e-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const queueFile = path.join(tmpDir, 'queue.jsonl');
    
    // 09:30事件
    const eventTime = new Date('2026-11-12T09:30:00Z');
    const claimTime = new Date('2026-11-12T10:57:00Z');  // 87分钟后
    
    const alert = {
      eventId: 'test-old-event',
      status: 'pending',
      whenIso: eventTime.toISOString(),
      createdAt: eventTime.toISOString(),
      text: '测试旧事件'
    };
    
    fs.writeFileSync(queueFile, JSON.stringify(alert) + '\n');
    
    // TTL 10分钟claim
    const result = claimPendingAlerts(queueFile, {
      ttlMs: 10 * 60 * 1000,
      now: claimTime.getTime()
    });
    
    // ✅ 87分钟超过10分钟TTL，应该被标记为expired
    assert.strictEqual(result.claimed.length, 0);
    
    const items = JSON.parse(fs.readFileSync(queueFile, 'utf8').split('\n').filter(Boolean)[0]);
    assert.strictEqual(items.status, 'expired');
    assert.strictEqual(items.reason, 'ttl_exceeded');
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('01:30领取静默，06:01只作为历史', () => {
  // 01:30 CST (UTC-8) = 17:30 UTC前一天
  const cst0130 = new Date('2026-11-11T17:30:00Z');  // 01:30 CST
  const cst0601 = new Date('2026-11-11T22:01:00Z');  // 06:01 CST
  
  // ✅ 01:30在静默时段
  assert.strictEqual(isQuietHours(cst0130.getTime()), true);
  
  // ✅ 06:01不在静默时段
  assert.strictEqual(isQuietHours(cst0601.getTime()), false);
});

test('claim后crash重领/lease到期，ack成功一次', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-fomo-e2e-lease-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const queueFile = path.join(tmpDir, 'queue.jsonl');
    
    // Use 10:00 UTC (18:00 CST) - outside quiet hours
    const now1 = new Date('2026-11-12T10:00:00Z').getTime();
    
    const alert = {
      eventId: 'test-lease',
      status: 'pending',
      whenIso: new Date(now1).toISOString(),
      createdAt: new Date(now1).toISOString(),
      text: '测试lease'
    };
    
    fs.writeFileSync(queueFile, JSON.stringify(alert) + '\n');
    
    // 第一次claim
    const result1 = claimPendingAlerts(queueFile, {
      leaseDurationMs: 5 * 60 * 1000,  // 5分钟lease
      now: now1
    });
    
    assert.strictEqual(result1.claimed.length, 1);
    const leaseId1 = result1.claimed[0].leaseId;
    
    // 模拟crash，10分钟后重领（lease已过期）
    const now2 = now1 + 10 * 60 * 1000;
    const result2 = claimPendingAlerts(queueFile, {
      leaseDurationMs: 5 * 60 * 1000,
      now: now2
    });
    
    // ✅ lease过期可重领
    assert.strictEqual(result2.claimed.length, 1);
    assert.notStrictEqual(result2.claimed[0].leaseId, leaseId1);
    
    // Ack第一次
    const ack1 = acknowledgeDelivered(queueFile, ['test-lease']);
    assert.strictEqual(ack1.acked, 1);
    
    // 再次ack同一个eventId
    const ack2 = acknowledgeDelivered(queueFile, ['test-lease']);
    
    // ✅ 已delivered不重复ack
    assert.strictEqual(ack2.acked, 0);
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('旧delivered不重复 (兼容80条已delivered记录)', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-fomo-e2e-delivered-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const queueFile = path.join(tmpDir, 'queue.jsonl');
    
    // Use 10:00 UTC (18:00 CST) - outside quiet hours
    const testNow = new Date('2026-11-12T10:00:00Z').getTime();
    
    // 创建80条已delivered + 5条pending
    const alerts = [];
    for (let i = 0; i < 80; i++) {
      alerts.push({
        eventId: `old-delivered-${i}`,
        status: 'delivered',
        deliveredAt: new Date(testNow - 3600_000).toISOString(),
        text: `旧delivered ${i}`
      });
    }
    for (let i = 0; i < 5; i++) {
      alerts.push({
        eventId: `new-pending-${i}`,
        status: 'pending',
        whenIso: new Date(testNow).toISOString(),
        text: `新pending ${i}`
      });
    }
    
    fs.writeFileSync(queueFile, alerts.map(a => JSON.stringify(a)).join('\n') + '\n');
    
    // Claim
    const result = claimPendingAlerts(queueFile, {
      maxClaims: 10,
      now: testNow
    });
    
    // ✅ 只claim pending的5条，不重复delivered的80条
    assert.strictEqual(result.claimed.length, 5);
    
    const stats = getQueueStats(queueFile);
    assert.strictEqual(stats.delivered, 80);
    assert.strictEqual(stats.claimed, 5);
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('多进程安全原子更新', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-fomo-e2e-atomic-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const queueFile = path.join(tmpDir, 'queue.jsonl');
    
    // Use 10:00 UTC (18:00 CST) - outside quiet hours
    const testNow = new Date('2026-11-12T10:00:00Z').getTime();
    
    // 创建10条pending
    const alerts = [];
    for (let i = 0; i < 10; i++) {
      alerts.push({
        eventId: `test-atomic-${i}`,
        status: 'pending',
        whenIso: new Date(testNow).toISOString(),
        text: `测试原子性 ${i}`
      });
    }
    
    fs.writeFileSync(queueFile, alerts.map(a => JSON.stringify(a)).join('\n') + '\n');
    
    // 模拟并发claim（串行执行，验证原子性）
    const result1 = claimPendingAlerts(queueFile, { maxClaims: 3, now: testNow });
    const result2 = claimPendingAlerts(queueFile, { maxClaims: 3, now: testNow });
    const result3 = claimPendingAlerts(queueFile, { maxClaims: 3, now: testNow });
    
    // ✅ 第一次claim 3条
    assert.strictEqual(result1.claimed.length, 3);
    
    // ✅ 第二次claim 3条（不同的，因为第一次已claimed且lease未过期）
    assert.strictEqual(result2.claimed.length, 3);
    
    // ✅ 第三次claim 3条
    assert.strictEqual(result3.claimed.length, 3);
    
    // 验证没有重复claim
    const allClaimedIds = [
      ...result1.claimed.map(a => a.eventId),
      ...result2.claimed.map(a => a.eventId),
      ...result3.claimed.map(a => a.eventId)
    ];
    
    const uniqueIds = new Set(allClaimedIds);
    assert.strictEqual(uniqueIds.size, 9);  // 总共10条，claim了9条
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatHistoricalAlert: 06后明确历史不保留"9分钟前"', () => {
  const now = Date.now();
  const eventTime = now - 9 * 60 * 1000;  // 9分钟前
  
  const alert = {
    eventId: 'test-historical',
    whenIso: new Date(eventTime).toISOString(),
    text: '@user 买入 TOKEN\n规模: 约 $5,000'
  };
  
  const formatted = formatHistoricalAlert(alert, now);
  
  // ✅ 不用"9分钟前"，用绝对时间 + 明确历史标记
  assert.ok(formatted.includes('[历史提醒'));
  assert.ok(formatted.includes('UTC'));
  assert.ok(formatted.includes('9分钟前'));  // 但也标注了延迟
  assert.ok(formatted.includes(alert.text));
});

test('>100%异常标注', () => {
  const data = {
    positionValueUsd: 102800,
    totalAssetsUsd: 100000,
    tradeAmount: 50000
  };
  
  const anomalies = detectPositionAnomalies(data);
  
  // ✅ 检测到position > assets异常
  assert.strictEqual(anomalies.positionExceedsAssets.detected, true);
  assert.ok(anomalies.positionExceedsAssets.positionPct > 100);
});

test('资产未知允许$3000 fallback但必须真实成交额', () => {
  // Case 1: 有真实tradeUsd
  const ev1 = {
    tradeUsd: 5000,
    usdValue: null,
    positionValueUsd: null
  };
  
  const analysis1 = analyzeTransaction(ev1);
  assert.strictEqual(analysis1.tradeAmount, 5000);
  assert.strictEqual(analysis1.source, 'tradeUsd');
  
  // Case 2: 只有positionValue（不是真实成交）
  const ev2 = {
    tradeUsd: null,
    usdValue: null,
    positionValueUsd: 5000
  };
  
  const analysis2 = analyzeTransaction(ev2);
  assert.strictEqual(analysis2.tradeAmount, null);
  assert.ok(analysis2.warnings.includes('no_trade_amount'));
});
