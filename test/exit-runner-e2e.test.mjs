#!/usr/bin/env node
/**
 * Exit Runner E2E Tests (2026-11-12)
 * 
 * Tests:
 * ✅ Fixture scan → register watchlist → refresh snapshots → pending alerts → claim → ack → no duplicate
 * ✅ 同名不同CA独立跟踪
 * ✅ 样本不完整不判清仓
 * ✅ 跌出榜继续监控
 * ✅ 数据源失败降级
 * ✅ 预算用尽
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadWatchlist,
  saveWatchlist,
  registerFromScanResults,
  markDroppedFromBoard,
  refreshHoldings,
  analyzeAndCreateAlerts,
  writeAlertsToQueue,
  calculateRefreshInterval
} from '../src/modules/exit-runner-production.mjs';

import {
  claimPendingAlerts,
  acknowledgeDelivered,
  getQueueStats
} from '../src/modules/alert-queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Fixture scan → register → refresh → alert → claim → ack → no duplicate', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-exit-e2e-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const watchlistFile = path.join(tmpDir, 'watchlist.json');
    const queueFile = path.join(tmpDir, 'queue.jsonl');
    
    // 1. Fixture scan results (real schema from offline-samples.json)
    const scanResults = {
      scannedAt: new Date().toISOString(),
      candidates: [
        {
          chain: 'sol',
          address: '8yLBuP74RnFmjSRS8BGFebvyoTo8uiEjPB71h3Zgpump',
          symbol: 'NIHAO',
          rank: 3,
          mcap: 4215069,
          liquidity_usd: 165162.18
        },
        {
          chain: 'bsc',
          address: '0x1234567890123456789012345678901234567890',
          symbol: 'TEST',
          rank: 5,
          mcap: 250000
        }
      ]
    };
    
    // 2. Register to watchlist
    let watchlist = loadWatchlist(watchlistFile);
    const regResult = registerFromScanResults(scanResults, watchlist);
    
    assert.strictEqual(regResult.registered.length, 2);
    assert.strictEqual(regResult.total, 2);
    
    saveWatchlist(watchlistFile, regResult.watchlist);
    
    // 3. Refresh holdings (mock data source)
    watchlist = loadWatchlist(watchlistFile);
    const item = watchlist.items[0];
    
    const mockGetters = {
      getFreeHolders: async () => ({
        smartWallets: [
          { address: 'SMART_A', amount: 1000, amountUsd: 50 },
          { address: 'SMART_B', amount: 2000, amountUsd: 100 }
        ],
        totalSampleSize: 2,
        sampleComplete: true
      }),
      checkBudget: () => true
    };
    
    // First refresh (establish baseline)
    const refresh1 = await refreshHoldings(item, mockGetters, {});
    assert.strictEqual(refresh1.success, true);
    assert.strictEqual(item.snapshotHistory.length, 1);
    
    // No alert on first refresh
    let alerts = analyzeAndCreateAlerts(item);
    assert.strictEqual(alerts.length, 0, 'First refresh should not generate alerts');
    
    // 4. Second refresh with exit (2→0)
    mockGetters.getFreeHolders = async () => ({
      smartWallets: [],  // All exited
      totalSampleSize: 0,
      sampleComplete: true  // Complete sample confirms exit
    });
    
    const refresh2 = await refreshHoldings(item, mockGetters, {});
    assert.strictEqual(refresh2.success, true);
    assert.strictEqual(item.snapshotHistory.length, 2);
    
    // Should generate FULL_EXIT alert
    alerts = analyzeAndCreateAlerts(item);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].type, 'FULL_EXIT');
    assert.strictEqual(alerts[0].severity, 'CRITICAL');
    assert.strictEqual(alerts[0].exitedCount, 2);
    
    // 5. Write to queue
    const writeResult = writeAlertsToQueue(alerts, queueFile);
    assert.strictEqual(writeResult.written, 1);
    
    // 6. Claim from queue
    const testNow = new Date('2026-11-12T10:00:00Z').getTime();
    const claimResult = claimPendingAlerts(queueFile, {
      maxClaims: 5,
      ttlMs: 24 * 60 * 60 * 1000,  // 24h TTL for exit monitoring
      now: testNow
    });
    
    assert.strictEqual(claimResult.claimed.length, 1);
    assert.ok(claimResult.claimed[0].leaseId);
    assert.strictEqual(claimResult.claimed[0].status, 'claimed');
    
    // 7. Ack after delivery
    const ackResult = acknowledgeDelivered(queueFile, [claimResult.claimed[0].eventId]);
    assert.strictEqual(ackResult.acked, 1);
    
    // 8. Try to claim again - should not get the same alert (already delivered)
    const claim2Result = claimPendingAlerts(queueFile, {
      maxClaims: 5,
      ttlMs: 24 * 60 * 60 * 1000,
      now: testNow + 1000
    });
    
    assert.strictEqual(claim2Result.claimed.length, 0, 'Delivered alerts should not be claimed again');
    
    // 9. Verify queue stats
    const stats = getQueueStats(queueFile);
    assert.strictEqual(stats.delivered, 1);
    assert.strictEqual(stats.pending, 0);
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('同名不同CA独立跟踪 (NIHAO regression)', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-exit-nihao-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const watchlistFile = path.join(tmpDir, 'watchlist.json');
    
    // Two NIHAO tokens with different CAs (from offline-samples.json)
    const scanResults = {
      candidates: [
        {
          chain: 'sol',
          address: '8yLBuP74RnFmjSRS8BGFebvyoTo8uiEjPB71h3Zgpump',
          symbol: 'NIHAO',
          mcap: 4215069
        },
        {
          chain: 'sol',
          address: '416sPL5fqhQpAJVboEQC5Yq52kY4VXzVY6y2GdJhcGnz',
          symbol: 'NIHAO',
          mcap: 5530
        }
      ]
    };
    
    let watchlist = loadWatchlist(watchlistFile);
    const result = registerFromScanResults(scanResults, watchlist);
    
    // Should register both as separate entries
    assert.strictEqual(result.registered.length, 2);
    assert.strictEqual(result.watchlist.items.length, 2);
    
    // Verify they are tracked separately by chain:CA
    const keys = result.watchlist.items.map(item => `${item.chain}:${item.address}`);
    assert.strictEqual(new Set(keys).size, 2, 'Should have 2 unique chain:CA keys');
    
    // Both should have symbol NIHAO but different addresses
    const nihaoItems = result.watchlist.items.filter(item => item.symbol === 'NIHAO');
    assert.strictEqual(nihaoItems.length, 2);
    assert.notStrictEqual(nihaoItems[0].address, nihaoItems[1].address);
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('样本不完整不判清仓 (Sample incomplete → unknown)', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-exit-incomplete-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const watchlistFile = path.join(tmpDir, 'watchlist.json');
    
    const scanResults = {
      candidates: [{
        chain: 'sol',
        address: 'TEST123',
        symbol: 'INCOMPLETE',
        rank: 10
      }]
    };
    
    let watchlist = loadWatchlist(watchlistFile);
    const result = registerFromScanResults(scanResults, watchlist);
    saveWatchlist(watchlistFile, result.watchlist);
    
    watchlist = loadWatchlist(watchlistFile);
    const item = watchlist.items[0];
    
    // First refresh: 2 holders (complete sample)
    const mockGetters1 = {
      getFreeHolders: async () => ({
        smartWallets: [
          { address: 'SMART_A', amount: 1000 },
          { address: 'SMART_B', amount: 2000 }
        ],
        totalSampleSize: 2,
        sampleComplete: true  // Complete
      }),
      checkBudget: () => true
    };
    
    await refreshHoldings(item, mockGetters1, {});
    assert.strictEqual(item.snapshotHistory[0].sampleComplete, true);
    
    // Second refresh: 0 holders but INCOMPLETE sample
    const mockGetters2 = {
      getFreeHolders: async () => ({
        smartWallets: [],
        totalSampleSize: 0,
        sampleComplete: false  // ❌ Sample incomplete!
      }),
      checkBudget: () => true
    };
    
    await refreshHoldings(item, mockGetters2, {});
    assert.strictEqual(item.snapshotHistory[1].sampleComplete, false);
    
    // Should NOT generate exit alert (sample incomplete)
    const alerts = analyzeAndCreateAlerts(item);
    assert.strictEqual(alerts.length, 0, '样本不完整不应判定清仓');
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('跌出榜继续监控 (Dropped from board)', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-exit-dropped-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const watchlistFile = path.join(tmpDir, 'watchlist.json');
    
    // Initial scan with token on board
    const scan1 = {
      candidates: [{
        chain: 'sol',
        address: 'DROPPED123',
        symbol: 'DROP',
        rank: 5
      }]
    };
    
    let watchlist = loadWatchlist(watchlistFile);
    let result = registerFromScanResults(scan1, watchlist);
    saveWatchlist(watchlistFile, result.watchlist);
    
    // Next scan without the token (dropped from board)
    const scan2 = {
      candidates: []  // Token dropped
    };
    
    watchlist = loadWatchlist(watchlistFile);
    markDroppedFromBoard(watchlist, scan2.candidates);
    
    // Should be marked as dropped
    const item = watchlist.items.find(i => i.symbol === 'DROP');
    assert.ok(item);
    assert.strictEqual(item.droppedFromBoard, true);
    assert.ok(item.droppedAt);
    
    // Should still be in watchlist (continue monitoring)
    assert.strictEqual(watchlist.items.length, 1);
    assert.strictEqual(item.status, 'watching');
    
    // Generate alert for dropped
    const alerts = analyzeAndCreateAlerts(item);
    
    // Should have DROPPED_FROM_BOARD alert
    const droppedAlert = alerts.find(a => a.type === 'DROPPED_FROM_BOARD');
    assert.ok(droppedAlert);
    assert.strictEqual(droppedAlert.severity, 'INFO');
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('数据源失败降级 (Data source failure)', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-exit-failure-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const watchlistFile = path.join(tmpDir, 'watchlist.json');
    
    const scanResults = {
      candidates: [{
        chain: 'sol',
        address: 'FAIL123',
        symbol: 'FAIL',
        rank: 3
      }]
    };
    
    let watchlist = loadWatchlist(watchlistFile);
    const result = registerFromScanResults(scanResults, watchlist);
    saveWatchlist(watchlistFile, result.watchlist);
    
    watchlist = loadWatchlist(watchlistFile);
    const item = watchlist.items[0];
    
    // Mock: free source fails, Fomo also fails
    const mockGetters = {
      getFreeHolders: async () => null,  // Free fails
      getFomoHolders: async () => null,  // Fomo also fails
      checkBudget: () => true
    };
    
    const refreshResult = await refreshHoldings(item, mockGetters, {});
    
    // Should fail gracefully
    assert.strictEqual(refreshResult.success, false);
    assert.strictEqual(refreshResult.reason, 'no_data');
    
    // Snapshot history should remain empty
    assert.strictEqual(item.snapshotHistory.length, 0);
    
    // No alerts generated (no data)
    const alerts = analyzeAndCreateAlerts(item);
    assert.strictEqual(alerts.length, 0);
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('预算用尽 (Budget exhausted)', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-exit-budget-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const watchlistFile = path.join(tmpDir, 'watchlist.json');
    
    const scanResults = {
      candidates: [{
        chain: 'sol',
        address: 'BUDGET123',
        symbol: 'BUDGET',
        rank: 1
      }]
    };
    
    let watchlist = loadWatchlist(watchlistFile);
    const result = registerFromScanResults(scanResults, watchlist);
    saveWatchlist(watchlistFile, result.watchlist);
    
    watchlist = loadWatchlist(watchlistFile);
    const item = watchlist.items[0];
    
    // Mock: free source fails, budget exhausted for Fomo
    const mockGetters = {
      getFreeHolders: async () => null,
      getFomoHolders: null,  // Not even trying Fomo
      checkBudget: () => false  // ❌ Budget exhausted
    };
    
    const refreshResult = await refreshHoldings(item, mockGetters, {});
    
    // Should fail due to no data
    assert.strictEqual(refreshResult.success, false);
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('calculateRefreshInterval: 推荐间隔由公式算出', () => {
  // 10 tokens, 15000 monthly budget
  const result1 = calculateRefreshInterval(10, 15000, 250);
  
  assert.ok(result1.intervalHours >= 4, 'Should be at least 4 hours');
  assert.ok(result1.formula.includes('15000'), 'Should show budget in formula');
  assert.ok(result1.formula.includes('10 tokens'), 'Should show token count');
  assert.strictEqual(typeof result1.perTokenRefreshesPerMonth, 'number');
  assert.strictEqual(typeof result1.monthlyBudgetUsed, 'number');
  
  // Larger watchlist should increase interval
  const result2 = calculateRefreshInterval(50, 15000, 250);
  assert.ok(result2.intervalHours >= result1.intervalHours);
  
  // Smaller budget should increase interval
  const result3 = calculateRefreshInterval(10, 5000, 250);
  assert.ok(result3.intervalHours >= result1.intervalHours);
});

test('Net selling pressure alert', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-exit-pressure-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    const watchlistFile = path.join(tmpDir, 'watchlist.json');
    
    const scanResults = {
      candidates: [{
        chain: 'sol',
        address: 'PRESSURE123',
        symbol: 'PRESS',
        rank: 2
      }]
    };
    
    let watchlist = loadWatchlist(watchlistFile);
    const result = registerFromScanResults(scanResults, watchlist);
    saveWatchlist(watchlistFile, result.watchlist);
    
    watchlist = loadWatchlist(watchlistFile);
    const item = watchlist.items[0];
    
    // First: 5 holders
    const mockGetters1 = {
      getFreeHolders: async () => ({
        smartWallets: [
          { address: 'A', amount: 100 },
          { address: 'B', amount: 200 },
          { address: 'C', amount: 300 },
          { address: 'D', amount: 400 },
          { address: 'E', amount: 500 }
        ],
        sampleComplete: true
      }),
      checkBudget: () => true
    };
    
    await refreshHoldings(item, mockGetters1, {});
    
    // Second: 3 exited, 1 new entered (net -2)
    const mockGetters2 = {
      getFreeHolders: async () => ({
        smartWallets: [
          { address: 'A', amount: 100 },  // Stayed
          { address: 'B', amount: 200 },  // Stayed
          { address: 'F', amount: 150 }   // New
          // C, D, E exited
        ],
        sampleComplete: true
      }),
      checkBudget: () => true
    };
    
    await refreshHoldings(item, mockGetters2, {});
    
    // Should generate NET_SELLING_PRESSURE alert
    const alerts = analyzeAndCreateAlerts(item);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].type, 'NET_SELLING_PRESSURE');
    assert.strictEqual(alerts[0].exitedCount, 3);
    assert.strictEqual(alerts[0].enteredCount, 1);
    assert.strictEqual(alerts[0].netChange, -2);
    assert.strictEqual(alerts[0].severity, 'HIGH');  // 3 exits = HIGH
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
