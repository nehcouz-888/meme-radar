/**
 * Tests for Exit Monitoring & Watchlist (Audit Fix #1)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoRegisterToWatchlist,
  createHoldingSnapshot,
  analyzeHoldingChange,
  alertDedupeKey,
  shouldSendAlert
} from '../src/modules/exit-monitoring.mjs';

test('autoRegisterToWatchlist - 新登记', () => {
  const token = {
    chain: 'sol',
    address: '8yLBuP74RnFmjSRS8BGFebvyoTo8uiEjPB71h3Zgpump',
    symbol: 'NIHAO'
  };
  
  const emptyWatchlist = { items: [] };
  const result = autoRegisterToWatchlist(token, 'hot_board', emptyWatchlist);
  
  assert.equal(result.registered, true);
  assert.equal(result.watchlist.items.length, 1);
  assert.equal(result.newEntry.chain, 'sol');
  assert.equal(result.newEntry.address, token.address);
  assert.equal(result.newEntry.symbol, 'NIHAO');
  assert.equal(result.newEntry.registeredReason, 'hot_board');
});

test('autoRegisterToWatchlist - 重复登记只更新', () => {
  const token = {
    chain: 'sol',
    address: '8yLBuP74RnFmjSRS8BGFebvyoTo8uiEjPB71h3Zgpump',
    symbol: 'NIHAO'
  };
  
  const existing = {
    items: [{
      chain: 'sol',
      address: '8yLBuP74RnFmjSRS8BGFebvyoTo8uiEjPB71h3Zgpump',
      symbol: 'NIHAO',
      seenCount: 1,
      lastSeenAt: Date.now() - 3600000
    }]
  };
  
  const result = autoRegisterToWatchlist(token, 'hot_board', existing);
  
  assert.equal(result.registered, false);
  assert.equal(result.updated, true);
  assert.equal(result.watchlist.items.length, 1);
  assert.equal(result.entry.seenCount, 2);
});

test('createHoldingSnapshot - 完整样本', () => {
  const data = {
    smartWallets: [
      { address: 'SMART_A', tags: ['smart_degen'], amount: 1000 },
      { address: 'SMART_B', tags: ['smart_degen'], amount: 2000 }
    ],
    totalSampleSize: 2,
    sampleComplete: true
  };
  
  const snapshot = createHoldingSnapshot('fomo', data);
  
  assert.equal(snapshot.source, 'fomo');
  assert.equal(snapshot.sampleComplete, true);
  assert.equal(snapshot.smartWallets.length, 2);
  assert.match(snapshot.completenessNote, /完整/);
});

test('createHoldingSnapshot - 不完整样本', () => {
  const data = {
    smartWallets: [
      { address: 'SMART_A', tags: ['smart_degen'] }
    ],
    totalSampleSize: 1,
    sampleComplete: false
  };
  
  const snapshot = createHoldingSnapshot('fomo', data);
  
  assert.equal(snapshot.sampleComplete, false);
  assert.match(snapshot.completenessNote, /部分样本/);
});

test('analyzeHoldingChange - 样本不完整 → 无法确认清仓', () => {
  const prev = createHoldingSnapshot('fomo', {
    smartWallets: [
      { address: 'SMART_A' },
      { address: 'SMART_B' }
    ],
    totalSampleSize: 2,
    sampleComplete: true
  });
  
  const curr = createHoldingSnapshot('fomo', {
    smartWallets: [],
    totalSampleSize: 0,
    sampleComplete: false  // ← 样本不完整
  });
  
  const analysis = analyzeHoldingChange(prev, curr);
  
  assert.equal(analysis.conclusion, 'INSUFFICIENT_DATA');
  assert.equal(analysis.canConfirm, false);
  assert.match(analysis.reason, /样本不完整/);
  assert.match(analysis.note, /样本缺失 ≠ 钱包清仓/);
});

test('analyzeHoldingChange - 样本完整 → 确认全部清仓', () => {
  const prev = createHoldingSnapshot('fomo', {
    smartWallets: [
      { address: 'SMART_A' },
      { address: 'SMART_B' }
    ],
    totalSampleSize: 2,
    sampleComplete: true
  });
  
  const curr = createHoldingSnapshot('fomo', {
    smartWallets: [],
    totalSampleSize: 0,
    sampleComplete: true  // ← 确认完整且为空
  });
  
  const analysis = analyzeHoldingChange(prev, curr);
  
  assert.equal(analysis.conclusion, 'CONFIRMED_FULL_EXIT');
  assert.equal(analysis.canConfirm, true);
  assert.equal(analysis.severity, 'CRITICAL');
  assert.equal(analysis.exitedCount, 2);
});

test('analyzeHoldingChange - 净卖压', () => {
  const prev = createHoldingSnapshot('fomo', {
    smartWallets: [
      { address: 'SMART_A' },
      { address: 'SMART_B' },
      { address: 'SMART_C' }
    ],
    totalSampleSize: 3,
    sampleComplete: true
  });
  
  const curr = createHoldingSnapshot('fomo', {
    smartWallets: [
      { address: 'SMART_A' },  // 仍在
      { address: 'SMART_D' }   // 新进
    ],
    totalSampleSize: 2,
    sampleComplete: true
  });
  
  const analysis = analyzeHoldingChange(prev, curr);
  
  assert.equal(analysis.conclusion, 'NET_SELLING_PRESSURE');
  assert.equal(analysis.exitedCount, 2);  // B, C 退出
  assert.equal(analysis.enteredCount, 1);  // D 新进
  assert.equal(analysis.netChange, -1);
  assert.equal(analysis.severity, 'MEDIUM');
});

test('alertDedupeKey - 生成去重键', () => {
  const alert1 = {
    type: 'smart_money_reducing',
    chain: 'sol',
    address: '8yL...',
    severity: 'MEDIUM'
  };
  
  const alert2 = {
    type: 'smart_money_reducing',
    chain: 'sol',
    address: '8yL...',
    severity: 'MEDIUM'
  };
  
  const key1 = alertDedupeKey(alert1);
  const key2 = alertDedupeKey(alert2);
  
  assert.equal(key1, key2);
  assert.match(key1, /smart_money_reducing:sol:8yL...:MEDIUM/);
});

test('shouldSendAlert - 去重窗口内不重复发送', () => {
  const alert = {
    type: 'smart_money_reducing',
    chain: 'sol',
    address: '8yL...',
    severity: 'MEDIUM'
  };
  
  const item = {
    alerts: [
      {
        type: 'smart_money_reducing',
        chain: 'sol',
        address: '8yL...',
        severity: 'MEDIUM',
        sentAt: Date.now() - 1800_000  // 30分钟前
      }
    ]
  };
  
  // 1小时去重窗口，30分钟前的alert仍在窗口内
  const should = shouldSendAlert(alert, item, 3600_000);
  assert.equal(should, false);
});

test('shouldSendAlert - 超出去重窗口可以发送', () => {
  const alert = {
    type: 'smart_money_reducing',
    chain: 'sol',
    address: '8yL...',
    severity: 'MEDIUM'
  };
  
  const item = {
    alerts: [
      {
        type: 'smart_money_reducing',
        chain: 'sol',
        address: '8yL...',
        severity: 'MEDIUM',
        sentAt: Date.now() - 7200_000  // 2小时前
      }
    ]
  };
  
  // 1小时去重窗口，2小时前的alert已过期
  const should = shouldSendAlert(alert, item, 3600_000);
  assert.equal(should, true);
});

// Offline sample test: NIHAO两个CA不串联
test('NIHAO regression - 两个不同CA独立跟踪', () => {
  const nihao1 = {
    chain: 'sol',
    address: '8yLBuP74RnFmjSRS8BGFebvyoTo8uiEjPB71h3Zgpump',
    symbol: 'NIHAO'
  };
  
  const nihao2 = {
    chain: 'sol',
    address: '416sPL5fqhQpAJVboEQC5Yq52kY4VXzVY6y2GdJhcGnz',
    symbol: 'NIHAO'
  };
  
  const watchlist = { items: [] };
  
  // 登记第一个
  const r1 = autoRegisterToWatchlist(nihao1, 'hot_board', watchlist);
  assert.equal(r1.registered, true);
  
  // 登记第二个（不同CA，应该独立登记）
  const r2 = autoRegisterToWatchlist(nihao2, 'hot_board', r1.watchlist);
  assert.equal(r2.registered, true);
  assert.equal(r2.watchlist.items.length, 2);
  
  // 验证两个entry不同
  const items = r2.watchlist.items;
  assert.notEqual(items[0].address, items[1].address);
  assert.equal(items[0].symbol, 'NIHAO');
  assert.equal(items[1].symbol, 'NIHAO');
});
